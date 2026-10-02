/**
 * Property matrix for the id-keyed transcript merge (mergeConversationOnto).
 *
 * Every scenario runs under every id-configuration — both sides id'd, one
 * side only, neither, mixed within one array — and every output is checked
 * against the merge's core invariants:
 *
 *  - I1 size: never below either (deduped) side — nothing shrinks away,
 *  - I2 no duplicate ids in the output,
 *  - I3 every id present on either side survives,
 *  - I4 a shared id keeps the INCOMING copy (content rewrites stay
 *    caller-owned — the titler-shell-vs-renderer contract),
 *  - I5 disk order is the spine (disk ids keep their relative order),
 *  - I6 deterministic: the same inputs merge identically twice.
 *
 * Golden outputs are asserted only for the fully-id'd configuration (the
 * steady state after the launch migration) and for the fully-id-less one
 * (which must reproduce the legacy caller-wins-except-shrink semantics
 * verbatim). Field rules — channel guard, disk-title-beats-Untitled, and
 * the summary mark re-anchoring onto the merged array — get their own cases.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/message-id-merge.test.ts
 */

import {
  mergeConversationOnto,
  type ConversationFile,
  type ConversationMessage
} from '@main/conversations'

let passed = 0
let failed = 0
function ok(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++
    return
  }
  failed++
  console.error(`FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

function msg(id: string | null, role: 'user' | 'assistant', content: string): ConversationMessage {
  const m: ConversationMessage = { role, content, timestamp: 1_000 }
  if (id) m.id = id
  return m
}

function conv(
  messages: ConversationMessage[],
  extra: Partial<ConversationFile> = {}
): ConversationFile {
  return {
    id: 'c1',
    title: 'T',
    model: null,
    messages,
    createdAt: 1,
    updatedAt: 2,
    ...extra
  }
}

const clone = <T>(v: T): T => structuredClone(v)

/** Strip ids per configuration; 'mixed' keeps ids on the first half only. */
type IdMode = 'all' | 'none' | 'mixed'
function applyIdMode(messages: ConversationMessage[], mode: IdMode): ConversationMessage[] {
  return messages.map((m, i) => {
    if (mode === 'all') return clone(m)
    if (mode === 'none' || i >= Math.ceil(messages.length / 2)) {
      const c = clone(m)
      delete c.id
      return c
    }
    return clone(m)
  })
}

// ── the scenario matrix ────────────────────────────────────────────────────

const u1 = msg('A', 'user', 'first question')
const a1 = msg('B', 'assistant', 'first answer')
const prefix = [u1, a1]

type Scenario = { name: string; disk: ConversationMessage[]; incoming: ConversationMessage[] }
const scenarios: Scenario[] = [
  {
    name: 'disjoint appends',
    disk: [...prefix, msg('C', 'user', 'channel message')],
    incoming: [
      ...prefix,
      msg('D', 'user', 'renderer question'),
      msg('E', 'assistant', 'renderer answer')
    ]
  },
  {
    name: 'same-index divergence',
    disk: [...prefix, msg('C', 'user', 'channel message')],
    incoming: [...prefix, msg('D', 'user', 'renderer question')]
  },
  {
    name: 'shrink attempt',
    disk: [...prefix, msg('C', 'user', 'later'), msg('D', 'assistant', 'latest')],
    incoming: [...prefix]
  },
  {
    name: 'equal-count rewrite',
    disk: [msg('A', 'user', 'composed content\n\n<attachments>…</attachments>'), a1],
    incoming: [msg('A', 'user', 'bare text'), a1]
  },
  {
    name: 'duplicate incoming ids',
    disk: [...prefix],
    incoming: [...prefix, msg('D', 'user', 'kept copy'), msg('D', 'user', 'dropped duplicate')]
  },
  {
    name: 'reordered incoming',
    disk: [...prefix, msg('C', 'user', 'third')],
    incoming: [msg('C', 'user', 'third'), u1, a1]
  },
  { name: 'empty disk', disk: [], incoming: [...prefix] },
  { name: 'empty incoming', disk: [...prefix], incoming: [] },
  {
    name: 'normal append',
    disk: [...prefix],
    incoming: [...prefix, msg('C', 'user', 'follow-up'), msg('D', 'assistant', 'reply')]
  },
  {
    name: 'titler shell vs first save',
    disk: [msg('A', 'user', 'composed shell copy')],
    incoming: [msg('A', 'user', 'bare text'), msg('B', 'assistant', 'answer')]
  }
]

const idModes: IdMode[] = ['all', 'none', 'mixed']

function dedupeIds(messages: ConversationMessage[]): ConversationMessage[] {
  const seen = new Set<string>()
  return messages.filter((m) => {
    if (!m.id) return true
    if (seen.has(m.id)) return false
    seen.add(m.id)
    return true
  })
}

for (const scenario of scenarios) {
  for (const diskMode of idModes) {
    for (const incomingMode of idModes) {
      const label = `${scenario.name} [disk:${diskMode} incoming:${incomingMode}]`
      const disk = conv(applyIdMode(scenario.disk, diskMode))
      const incoming = conv(applyIdMode(scenario.incoming, incomingMode))
      const diskSnapshot = clone(disk)
      const incomingSnapshot = clone(incoming)

      const out = mergeConversationOnto(disk, incoming).messages
      const rerun = mergeConversationOnto(clone(diskSnapshot), clone(incomingSnapshot)).messages

      // I6 determinism (clone inputs, byte-compare outputs)
      ok(`${label}: deterministic`, JSON.stringify(out) === JSON.stringify(rerun))

      // I1 size
      const dLen = dedupeIds(diskSnapshot.messages).length
      const iLen = dedupeIds(incomingSnapshot.messages).length
      ok(
        `${label}: never below either side`,
        out.length >= Math.max(dLen, iLen),
        `out=${out.length} disk=${dLen} incoming=${iLen}`
      )

      // I2 unique ids
      const outIds = out.filter((m) => m.id).map((m) => m.id!)
      ok(`${label}: no duplicate ids`, new Set(outIds).size === outIds.length, outIds.join(','))

      // I3 id coverage
      const wantIds = new Set([
        ...diskSnapshot.messages.filter((m) => m.id).map((m) => m.id!),
        ...incomingSnapshot.messages.filter((m) => m.id).map((m) => m.id!)
      ])
      const missing = [...wantIds].filter((id) => !outIds.includes(id))
      ok(`${label}: every id survives`, missing.length === 0, `missing=${missing.join(',')}`)

      // I4 incoming copy wins on shared ids (first occurrence)
      const incomingById = new Map(
        dedupeIds(incomingSnapshot.messages)
          .filter((m) => m.id)
          .map((m) => [m.id!, m])
      )
      let sharedOk = true
      for (const m of out) {
        if (m.id && incomingById.has(m.id)) {
          if (JSON.stringify(m) !== JSON.stringify(incomingById.get(m.id))) sharedOk = false
        }
      }
      ok(`${label}: incoming copy wins on shared ids`, sharedOk)

      // I5 disk-order spine
      const diskIdOrder = dedupeIds(diskSnapshot.messages)
        .filter((m) => m.id)
        .map((m) => m.id!)
      const outDiskIds = outIds.filter((id) => diskIdOrder.includes(id))
      const expectedOrder = diskIdOrder.filter((id) => outDiskIds.includes(id))
      ok(
        `${label}: disk relative order preserved`,
        JSON.stringify(outDiskIds) === JSON.stringify(expectedOrder),
        `${outDiskIds.join(',')} vs ${expectedOrder.join(',')}`
      )
    }
  }
}

// ── golden outputs: fully id'd (post-migration steady state) ──────────────
{
  const golden = (name: string, out: ConversationMessage[], want: string[]): void =>
    ok(
      `golden(all ids) ${name}`,
      JSON.stringify(out.map((m) => m.id)) === JSON.stringify(want),
      out.map((m) => m.id).join(',')
    )

  golden(
    'disjoint appends → renderer turn, then channel message',
    mergeConversationOnto(conv(clone(scenarios[0].disk)), conv(clone(scenarios[0].incoming)))
      .messages,
    ['A', 'B', 'D', 'E', 'C']
  )
  golden(
    'same-index divergence → both survive',
    mergeConversationOnto(conv(clone(scenarios[1].disk)), conv(clone(scenarios[1].incoming)))
      .messages,
    ['A', 'B', 'D', 'C']
  )
  golden(
    'shrink attempt → disk tail survives',
    mergeConversationOnto(conv(clone(scenarios[2].disk)), conv(clone(scenarios[2].incoming)))
      .messages,
    ['A', 'B', 'C', 'D']
  )
  golden(
    'normal append → incoming as-is',
    mergeConversationOnto(conv(clone(scenarios[8].disk)), conv(clone(scenarios[8].incoming)))
      .messages,
    ['A', 'B', 'C', 'D']
  )
  const titler = mergeConversationOnto(
    conv(clone(scenarios[9].disk)),
    conv(clone(scenarios[9].incoming))
  ).messages
  golden('titler shell → shell reconciles, no duplicate', titler, ['A', 'B'])
  ok(`golden titler: renderer bare text wins`, titler[0].content === 'bare text', titler[0].content)

  const rewrite = mergeConversationOnto(
    conv(clone(scenarios[3].disk)),
    conv(clone(scenarios[3].incoming))
  ).messages
  ok('golden equal-count rewrite: incoming content wins', rewrite[0].content === 'bare text')

  const dup = mergeConversationOnto(
    conv(clone(scenarios[4].disk)),
    conv(clone(scenarios[4].incoming))
  ).messages
  ok(
    'golden duplicate incoming ids: first occurrence kept',
    dup.length === 3 && dup[2].content === 'kept copy',
    JSON.stringify(dup.map((m) => [m.id, m.content]))
  )
}

// ── golden outputs: fully id-less (legacy semantics, byte-preserved) ──────
{
  const strip = (ms: ConversationMessage[]): ConversationMessage[] => applyIdMode(ms, 'none')

  // caller wins wholesale on same-or-larger counts…
  const grow = mergeConversationOnto(
    conv(strip(scenarios[8].disk)),
    conv(strip(scenarios[8].incoming))
  ).messages
  ok(
    'legacy: normal append → incoming wins wholesale',
    grow.length === 4 && grow[2].content === 'follow-up'
  )

  const rewrite = mergeConversationOnto(
    conv(strip(scenarios[3].disk)),
    conv(strip(scenarios[3].incoming))
  ).messages
  ok('legacy: equal-count rewrite → incoming wins wholesale', rewrite[0].content === 'bare text')

  // …and a shrink is refused, disk transcript wins whole.
  const shrink = mergeConversationOnto(
    conv(strip(scenarios[2].disk)),
    conv(strip(scenarios[2].incoming))
  ).messages
  ok(
    'legacy: shrink refused, disk wins whole',
    shrink.length === 4 && shrink[2].content === 'later',
    JSON.stringify(shrink.map((m) => m.content))
  )
}

// ── null disk passes incoming through untouched ────────────────────────────
{
  const incoming = conv([...prefix.map(clone)])
  const out = mergeConversationOnto(null, incoming)
  ok('null disk → incoming verbatim', out === incoming)
}

// ── field rules: channel guard, title, summary re-anchoring ───────────────
{
  const disk = conv([...prefix.map(clone)], { channel: 'telegram', title: 'Real title' })
  const incoming = conv([...prefix.map(clone)], { title: 'Untitled' })
  const merged = mergeConversationOnto(disk, incoming)
  ok('channel: disk provenance survives a channel-less caller', merged.channel === 'telegram')
  ok('title: real disk title beats incoming Untitled', merged.title === 'Real title')
}
{
  // Disk summary is ahead → it wins and rides the merge.
  const disk = conv(
    [clone(u1), clone(a1), msg('C', 'user', 'third'), msg('D', 'assistant', 'fourth')],
    { summary: 'covers first two', summarizedThroughMessage: 2, summarizedThroughMessageId: 'C' }
  )
  const incoming = conv([
    clone(u1),
    clone(a1),
    msg('C', 'user', 'third'),
    msg('D', 'assistant', 'fourth')
  ])
  const merged = mergeConversationOnto(disk, incoming)
  ok(
    'summary: disk mark ahead wins',
    merged.summary === 'covers first two' &&
      merged.summarizedThroughMessage === 2 &&
      merged.summarizedThroughMessageId === 'C'
  )
}
{
  // THE mark-shift case the id form exists for: the union inserts the
  // renderer's messages BEFORE the marked message; the numeric mark must be
  // re-anchored so the summary still covers exactly [A, B].
  const disk = conv([clone(u1), clone(a1), msg('C', 'user', 'channel message')], {
    summary: 'covers A and B',
    summarizedThroughMessage: 2,
    summarizedThroughMessageId: 'C'
  })
  const incoming = conv(
    [
      clone(u1),
      clone(a1),
      msg('D', 'user', 'renderer question'),
      msg('E', 'assistant', 'renderer answer')
    ],
    { summary: 'covers A and B', summarizedThroughMessage: 2, summarizedThroughMessageId: 'C' }
  )
  const merged = mergeConversationOnto(disk, incoming)
  const order = merged.messages.map((m) => m.id).join(',')
  ok('summary re-anchor: merged order', order === 'A,B,D,E,C', order)
  ok(
    'summary re-anchor: numeric mark remapped onto merged array',
    merged.summarizedThroughMessage === 4 && merged.summarizedThroughMessageId === 'C',
    `mark=${merged.summarizedThroughMessage} id=${merged.summarizedThroughMessageId}`
  )
}
{
  // Legacy numeric-only mark (no id) upgrades through the merge when the
  // marked message itself carries an id.
  const disk = conv([clone(u1), clone(a1), msg('C', 'user', 'third')], {
    summary: 'covers A and B',
    summarizedThroughMessage: 2
  })
  const incoming = conv([clone(u1), clone(a1), msg('C', 'user', 'third')])
  const merged = mergeConversationOnto(disk, incoming)
  ok(
    'summary: numeric-only mark survives and upgrades to id',
    merged.summary === 'covers A and B' &&
      merged.summarizedThroughMessage === 2 &&
      merged.summarizedThroughMessageId === 'C',
    JSON.stringify({ m: merged.summarizedThroughMessage, id: merged.summarizedThroughMessageId })
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
