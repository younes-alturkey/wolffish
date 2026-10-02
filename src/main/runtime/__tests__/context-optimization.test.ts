/**
 * Context-optimization tests — the outbound volatile tail (internal
 * history must stay untouched), Anthropic cache breakpoint placement
 * (never on a volatile block), and the compaction trigger calibration
 * that replaces the 1.5 chars/token heuristic with provider actuals.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/context-optimization.test.ts
 * (the root tsconfig is solution-style with no paths — tsx needs the node
 * project config to resolve the @main/* alias reached via anthropic.ts)
 */

import { effectivePayloadTokens } from '../compactor'
import {
  formatClock,
  formatLastMessageNotice,
  formatRuntimeStatus,
  formatTimeGap,
  PHONE_NOTIFY_CHANNEL_NOTICE,
  PHONE_NOTIFY_NOTICE,
  PHONE_NOTIFY_SENT_NOTICE,
  RESUME_NOTICE_MIN_GAP_MS,
  shapeOutbound,
  truncateSuperseded,
  withVolatileTail
} from '../outbound'
import { toAnthropicMessages } from '../providers/anthropic'
import type { ChatMessage, ProviderStreamOptions } from '../thalamus'

let passed = 0
let failed = 0

function check(label: string, actual: unknown, expected: unknown): void {
  if (actual === expected) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}: expected ${String(expected)}, got ${String(actual)}`)
}

type Block = Record<string, unknown>

// ---------------------------------------------------------------------------
// withVolatileTail — outbound clone only, internal array untouched
// ---------------------------------------------------------------------------

const history: ChatMessage[] = [
  { role: 'user', content: 'do the task' },
  { role: 'assistant', content: '', toolUses: [{ id: 't1', name: 'browser_click', args: {} }] },
  { role: 'tool', toolUseId: 't1', toolName: 'browser_click', content: 'Clicked: button' }
]
const options: ProviderStreamOptions = {
  system: 'sys',
  messages: history,
  volatileStatus: '[runtime] Tool iteration this turn: 2. Tools called this turn: 1.'
}

const shaped = withVolatileTail(options)
check('tail: internal length unchanged', history.length, 3)
check('tail: clone has one extra message', shaped.messages.length, 4)
const tail = shaped.messages[3] as Extract<ChatMessage, { role: 'user' }>
check('tail: appended message is user', tail.role, 'user')
check('tail: appended message marked volatile', tail.volatile, true)
check('tail: internal last message is still the tool result', history[2].role, 'tool')
check(
  'tail: no-op without status',
  withVolatileTail({ system: 's', messages: history }).messages,
  history
)

// ---------------------------------------------------------------------------
// toAnthropicMessages — breakpoints skip the volatile block
// ---------------------------------------------------------------------------

const anthropic = toAnthropicMessages(shaped.messages)
// [user(task), assistant(tool_use), user(tool_result + volatile text)]
check('anthropic: message count (volatile merged, alternation holds)', anthropic.length, 3)
const lastMsg = anthropic[2]
check('anthropic: trailing turn is user', lastMsg.role, 'user')
const blocks = lastMsg.content as Block[]
check('anthropic: tool_result then volatile text', blocks.length, 2)
check('anthropic: first block is tool_result', blocks[0].type, 'tool_result')
check('anthropic: breakpoint on the tool_result block', Boolean(blocks[0].cache_control), true)
check('anthropic: volatile block is plain text', blocks[1].type, 'text')
check('anthropic: volatile block carries NO breakpoint', blocks[1].cache_control, undefined)
// anchor breakpoint on the earlier user turn (the task prompt)
const firstMsg = anthropic[0]
const firstBlocks = firstMsg.content as Block[]
check(
  'anthropic: anchor breakpoint on prior user turn',
  Boolean(firstBlocks[0].cache_control),
  true
)

// without a volatile tail, the final block gets the moving breakpoint
const plain = toAnthropicMessages(history)
const plainLast = plain[plain.length - 1].content as Block[]
check(
  'anthropic: final block marked when no volatile',
  Boolean(plainLast[plainLast.length - 1].cache_control),
  true
)

// breakpoint budget: at most 2 message-level markers (system + tools use the other 2)
function countBreakpoints(msgs: ReturnType<typeof toAnthropicMessages>): number {
  let n = 0
  for (const m of msgs) {
    if (typeof m.content === 'string') continue
    for (const b of m.content as Block[]) if (b.cache_control) n++
  }
  return n
}
check('anthropic: ≤2 message breakpoints (volatile run)', countBreakpoints(anthropic) <= 2, true)
const longHistory: ChatMessage[] = [
  { role: 'user', content: 'task' },
  { role: 'assistant', content: 'step one' },
  { role: 'user', content: 'go on' },
  { role: 'assistant', content: '', toolUses: [{ id: 'a', name: 'x', args: {} }] },
  { role: 'tool', toolUseId: 'a', toolName: 'x', content: 'out' }
]
check(
  'anthropic: ≤2 message breakpoints (long run)',
  countBreakpoints(toAnthropicMessages(longHistory)) <= 2,
  true
)

// ---------------------------------------------------------------------------
// effectivePayloadTokens — provider actuals replace the char heuristic
// ---------------------------------------------------------------------------

// the 2026-06-11 failure: charEstimate 754k vs real 297k — actuals must win
check('trigger: actuals replace overestimate', effectivePayloadTokens(754_544, 297_371), 297_371)
check('trigger: char estimate rules the first call', effectivePayloadTokens(50_000, 0), 50_000)
// floor guard: one iteration appended far more than the last call saw
check('trigger: floor catches runaway growth', effectivePayloadTokens(2_000_000, 10_000), 500_000)

// ---------------------------------------------------------------------------
// formatRuntimeStatus
// ---------------------------------------------------------------------------

const status = formatRuntimeStatus({ iteration: 7, toolsCalled: 12 })
check(
  'status: carries live counters',
  status.includes('Tool iteration this turn: 7. Tools called this turn: 12.'),
  true
)
check('status: declares itself non-conversational', status.includes('not a user message'), true)
check(
  'status: states the loop mechanic',
  status.includes('a response without tool calls ends the task'),
  true
)
check('status: embeds the host clock', status.includes('Current date/time:'), true)
// online is the silent default — the notice renders ONLY on a definitive false
check('status: no offline notice by default', status.includes('NETWORK: OFFLINE'), false)
check(
  'status: no offline notice while online',
  formatRuntimeStatus({ iteration: 1, toolsCalled: 0, online: true }).includes('NETWORK: OFFLINE'),
  false
)
check(
  'status: offline notice when host is offline',
  formatRuntimeStatus({ iteration: 1, toolsCalled: 0, online: false }).includes('NETWORK: OFFLINE'),
  true
)

// ---------------------------------------------------------------------------
// Phone-notification notice — no phone, no notice; the cadence reminder until
// one goes out, the don't-repeat guard after. The Agent owns which of the
// three strings it passes (availability, role and channel gates live there);
// what's asserted here is that the tail renders exactly what it's handed.
// ---------------------------------------------------------------------------

check(
  'phone: silent when no phone is reachable',
  formatRuntimeStatus({ iteration: 1, toolsCalled: 0 }).includes('PHONE:'),
  false
)
const phoneIdle = formatRuntimeStatus({
  iteration: 1,
  toolsCalled: 0,
  phoneNotify: PHONE_NOTIFY_NOTICE
})
check(
  'phone: cadence notice asks for a turn-closing send',
  phoneIdle.includes('END THIS TURN'),
  true
)
check(
  'phone: cadence notice names the current-conversation deeplink',
  phoneIdle.includes('wolffish://chat?id=current'),
  true
)
check(
  'phone: channel notice suppresses the duplicate turn-end buzz',
  formatRuntimeStatus({
    iteration: 1,
    toolsCalled: 0,
    phoneNotify: PHONE_NOTIFY_CHANNEL_NOTICE
  }).includes('do NOT close the turn with a duplicate notify_phone'),
  true
)
const phoneSent = formatRuntimeStatus({
  iteration: 4,
  toolsCalled: 6,
  phoneNotify: PHONE_NOTIFY_SENT_NOTICE
})
check('phone: sent notice forbids a repeat', phoneSent.includes('do not repeat it'), true)
check('phone: sent notice drops the send instruction', phoneSent.includes('END THIS TURN'), false)
// One tail, every notice — a phone notice must not displace the others.
check(
  'phone: coexists with the offline notice',
  (() => {
    const both = formatRuntimeStatus({
      iteration: 2,
      toolsCalled: 3,
      online: false,
      phoneNotify: PHONE_NOTIFY_NOTICE
    })
    return both.includes('NETWORK: OFFLINE') && both.includes('PHONE:')
  })(),
  true
)

// ---------------------------------------------------------------------------
// formatClock — deterministic given (now, timeZone)
// ---------------------------------------------------------------------------

check(
  'clock: weekday, ISO date, 24h time, offset, IANA zone',
  formatClock(new Date('2026-06-15T11:34:00Z'), 'Asia/Riyadh'),
  'Mon 2026-06-15 14:34 (GMT+03:00, Asia/Riyadh)'
)
check(
  'clock: half-hour offset zone',
  formatClock(new Date('2026-06-15T11:34:00Z'), 'Asia/Kolkata'),
  'Mon 2026-06-15 17:04 (GMT+05:30, Asia/Kolkata)'
)
check(
  'clock: DST-active negative offset zone',
  formatClock(new Date('2026-06-15T11:34:00Z'), 'America/Los_Angeles'),
  'Mon 2026-06-15 04:34 (GMT-07:00, America/Los_Angeles)'
)

// ---------------------------------------------------------------------------
// Conversation-resumed notice — the gap floor, coarse relative rendering,
// and the tail carrying whatever the Agent hands it. Replayed history has
// no timestamps, so this line is the model's only way to know the user is
// back after days/weeks/months.
// ---------------------------------------------------------------------------

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

check('gap: minutes', formatTimeGap(45 * MIN), '45 minutes ago')
check('gap: single hour', formatTimeGap(62 * MIN), 'about 1 hour ago')
check('gap: hours run to two days', formatTimeGap(36 * HOUR), 'about 36 hours ago')
check('gap: days', formatTimeGap(3 * DAY), '3 days ago')
check('gap: weeks', formatTimeGap(21 * DAY), 'about 3 weeks ago')
check('gap: months', formatTimeGap(90 * DAY), 'about 3 months ago')
check('gap: first year stays coarse', formatTimeGap(400 * DAY), 'over a year ago')
check('gap: years', formatTimeGap(3 * 365 * DAY), 'about 3 years ago')

const resumeNow = new Date('2026-06-15T11:34:00Z')
check(
  'resume: silent with no previous message',
  formatLastMessageNotice(null, resumeNow, 'Asia/Riyadh'),
  undefined
)
check(
  'resume: silent inside an active exchange (below the 30min floor)',
  formatLastMessageNotice(
    resumeNow.getTime() - (RESUME_NOTICE_MIN_GAP_MS - 1),
    resumeNow,
    'Asia/Riyadh'
  ),
  undefined
)
const resumed = formatLastMessageNotice(resumeNow.getTime() - 21 * DAY, resumeNow, 'Asia/Riyadh')
check('resume: carries the relative gap', resumed?.includes('about 3 weeks ago'), true)
check(
  'resume: carries the previous message full timestamp',
  resumed?.includes('Mon 2026-05-25 14:34 (GMT+03:00, Asia/Riyadh)'),
  true
)
check(
  'resume: warns that the transcript speaks from an older now',
  resumed?.includes('older "now"'),
  true
)
check(
  'status: renders the resume notice it is handed',
  formatRuntimeStatus({ iteration: 1, toolsCalled: 0, lastMessage: resumed }).includes(
    'CONVERSATION RESUMED'
  ),
  true
)
check('status: no resume notice by default', status.includes('CONVERSATION RESUMED'), false)

// ---------------------------------------------------------------------------
// truncateSuperseded — outbound truncation, cardinal-rule guarantees
// ---------------------------------------------------------------------------

const BIG_A = 'A'.repeat(2500)
const BIG_B = 'B'.repeat(2500)
const BIG_C = 'C'.repeat(2500)
const img = { mediaType: 'image/png', data: 'aGVsbG8=' }

function toolCallMsg(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return { role: 'assistant', content: '', toolUses: [{ id, name, args }] }
}
function toolResult(
  id: string,
  name: string,
  content: string,
  extra?: { isError?: boolean; images?: Array<{ mediaType: string; data: string }> }
): ChatMessage {
  return { role: 'tool', toolUseId: id, toolName: name, content, ...extra }
}
function contentOf(m: ChatMessage): string {
  return m.role === 'tool' ? m.content : ''
}

const trunkHistory: ChatMessage[] = [
  { role: 'user', content: 'mission' },
  toolCallMsg('r1', 'ext_read_page', {}),
  toolResult('r1', 'ext_read_page', BIG_A),
  toolCallMsg('r2', 'browser_page_content', { session_id: 's1' }),
  toolResult('r2', 'browser_page_content', BIG_B),
  toolCallMsg('r3', 'browser_page_content', { session_id: 's2' }),
  toolResult('r3', 'browser_page_content', BIG_C),
  toolCallMsg('r4', 'ext_read_page', {}),
  toolResult('r4', 'ext_read_page', BIG_B),
  toolCallMsg('r5', 'browser_page_content', { session_id: 's1' }),
  toolResult('r5', 'browser_page_content', BIG_A)
]
const truncated = truncateSuperseded(trunkHistory)

// r1 (older ext_read_page) superseded by r4; r2 (s1) superseded by r5; r3 (s2) is the
// latest of its own session and stays; r4 and r5 are latest of theirs and stay.
check(
  'truncate: older read stubbed',
  contentOf(truncated[2]).startsWith('[superseded page state'),
  true
)
check('truncate: stub names the tool', contentOf(truncated[2]).includes('ext_read_page'), true)
check('truncate: stub names the size', contentOf(truncated[2]).includes('2,500 chars'), true)
check(
  'truncate: older same-session read stubbed',
  contentOf(truncated[4]).startsWith('[superseded page state'),
  true
)
check('truncate: other session NOT stubbed', contentOf(truncated[6]), BIG_C)
check('truncate: latest ext_read_page kept full', contentOf(truncated[8]), BIG_B)
check('truncate: latest s1 read kept full', contentOf(truncated[10]), BIG_A)
check('truncate: internal array untouched', contentOf(trunkHistory[2]), BIG_A)
check('truncate: internal length unchanged', trunkHistory.length, truncated.length)

// stability: stubbing is idempotent and byte-stable across repeated calls
const twice = truncateSuperseded(truncateSuperseded(trunkHistory))
check('truncate: idempotent', JSON.stringify(twice), JSON.stringify(truncated))

// failed reads are evidence — never stubbed
const failHistory: ChatMessage[] = [
  toolCallMsg('f1', 'ext_read_page', {}),
  toolResult('f1', 'ext_read_page', BIG_A, { isError: true }),
  toolCallMsg('f2', 'ext_read_page', {}),
  toolResult('f2', 'ext_read_page', BIG_B)
]
check('truncate: failed read kept full', contentOf(truncateSuperseded(failHistory)[1]), BIG_A)

// small reads stay — stubbing tiny content costs more than it saves
const smallHistory: ChatMessage[] = [
  toolCallMsg('s1', 'ext_read_page', {}),
  toolResult('s1', 'ext_read_page', 'tiny page'),
  toolCallMsg('s2', 'ext_read_page', {}),
  toolResult('s2', 'ext_read_page', BIG_A)
]
check('truncate: small read kept', contentOf(truncateSuperseded(smallHistory)[1]), 'tiny page')

// duplicates: later byte-equal result points backward; earliest stays full
const dupHistory: ChatMessage[] = [
  toolCallMsg('d1', 'web_fetch', { url: 'x' }),
  toolResult('d1', 'web_fetch', BIG_C),
  toolCallMsg('d2', 'web_fetch', { url: 'x' }),
  toolResult('d2', 'web_fetch', BIG_C)
]
const dedup = truncateSuperseded(dupHistory)
check('dedup: earliest copy kept full', contentOf(dedup[1]), BIG_C)
check('dedup: later duplicate stubbed', contentOf(dedup[3]).startsWith('[duplicate result'), true)

// a duplicate of a superseded (stubbed) read keeps its full content — no dangling pointers
const dangleHistory: ChatMessage[] = [
  toolCallMsg('g1', 'ext_read_page', {}),
  toolResult('g1', 'ext_read_page', BIG_A),
  toolCallMsg('g2', 'ext_read_page', {}),
  toolResult('g2', 'ext_read_page', BIG_A)
]
const dangle = truncateSuperseded(dangleHistory)
check(
  'dedup: superseded earlier copy is stubbed',
  contentOf(dangle[1]).startsWith('[superseded page state'),
  true
)
check('dedup: latest identical read stays full (no dangling pointer)', contentOf(dangle[3]), BIG_A)

// screenshots: only the most recent image-bearing result keeps pixels
const shotHistory: ChatMessage[] = [
  toolCallMsg('p1', 'browser_screenshot', {}),
  toolResult('p1', 'browser_screenshot', 'shot one', { images: [img] }),
  toolCallMsg('p2', 'browser_screenshot', {}),
  toolResult('p2', 'browser_screenshot', 'shot two', { images: [img] })
]
const shots = truncateSuperseded(shotHistory)
const oldShot = shots[1] as Extract<ChatMessage, { role: 'tool' }>
const newShot = shots[3] as Extract<ChatMessage, { role: 'tool' }>
check('images: older screenshot dropped', oldShot.images, undefined)
check('images: older keeps its text with a note', oldShot.content.includes('shot one'), true)
check('images: note explains the omission', oldShot.content.startsWith('[screenshot omitted'), true)
check('images: latest screenshot kept', newShot.images?.length, 1)
check(
  'images: internal images untouched',
  (shotHistory[1] as Extract<ChatMessage, { role: 'tool' }>).images?.length,
  1
)

// the latest image-bearing message is immune to every pass, even when superseded
const immuneHistory: ChatMessage[] = [
  toolCallMsg('m1', 'browser_page_content', { session_id: 's1' }),
  toolResult('m1', 'browser_page_content', BIG_A, { images: [img] }),
  toolCallMsg('m2', 'browser_page_content', { session_id: 's1' }),
  toolResult('m2', 'browser_page_content', BIG_B)
]
const immune = truncateSuperseded(immuneHistory)
check('images: newest-screenshot message immune to supersede stub', contentOf(immune[1]), BIG_A)

// no-op fast path returns the same reference
const cleanHistory: ChatMessage[] = [
  toolCallMsg('c1', 'browser_click', {}),
  toolResult('c1', 'browser_click', 'Clicked: button')
]
check('truncate: no-op returns same array', truncateSuperseded(cleanHistory), cleanHistory)

// ---------------------------------------------------------------------------
// shapeOutbound — truncation and volatile tail compose; gate respected
// ---------------------------------------------------------------------------

const shapedFull = shapeOutbound({
  system: 's',
  messages: trunkHistory,
  truncateOutbound: true,
  volatileStatus: '[runtime] Tool iteration this turn: 3. Tools called this turn: 5.'
})
check(
  'shape: truncation applied',
  contentOf(shapedFull.messages[2]).startsWith('[superseded page state'),
  true
)
const shapedTail = shapedFull.messages[shapedFull.messages.length - 1] as Extract<
  ChatMessage,
  { role: 'user' }
>
check('shape: volatile tail last', shapedTail.volatile, true)
check('shape: internal untouched', contentOf(trunkHistory[2]), BIG_A)
const shapedOff = shapeOutbound({ system: 's', messages: trunkHistory, truncateOutbound: false })
check('shape: gate off → untouched same reference', shapedOff.messages, trunkHistory)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
