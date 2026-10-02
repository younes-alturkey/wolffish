/**
 * Tests for continuing a channel-owned conversation from the app, and for the
 * paginated /resume + /delete picker.
 *
 * Three units under test, all pure (no electron, no network):
 *
 *  - chat-binding.ts — pointing a channel chat at the conversation that just
 *    messaged it, so the user's reply continues THAT conversation. Pins the
 *    no-op case (already bound ⇒ zero writes), the idle-clock restart without
 *    which the next reply bounces straight out again, and that a conversation
 *    still in flight (an automation's, unwritten until its run ends) binds —
 *    the case the feature exists for.
 *
 *  - mergeConversationOnto (conversations.ts) — now that the renderer can save
 *    a channel-owned conversation, this is the one place its whole-file copy
 *    meets the disk. The caller still owns `messages` outright (matching
 *    messages across writers is not sound — see the titler-shell case below),
 *    so what these tests pin is that the merge leaves every existing
 *    conversation byte-identical and can never erase a conversation's channel.
 *
 *  - conversation-picker.ts — the paging arithmetic and reply parsing shared
 *    by both channels' pickers: 25 rows a page, `next` for the following page,
 *    numbering continuous across pages (page 2 opens at 26), only what has
 *    actually been shown being selectable, and the origin label each row shows.
 *
 * The last section is an end-to-end pass over the REAL conversation files in
 * the live workspace (read-only — it never writes): backward-compat of the
 * merge, plus the cross-channel /resume — every conversation, all origins,
 * paged 25 at a time with continuous numbering. Skipped when no workspace.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/conversation-continuation.test.ts
 */

import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

// Shim `electron` before conversations.ts loads: it pulls in workspace.ts,
// which touches electron.app at import and would crash outside Electron.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => os.tmpdir() }
    }
  }
  return origLoad.apply(this, args)
}

import { bindChatToConversation, type ChatBindingIO } from '../chat-binding'
import {
  isNextPageReply,
  keycapNumber,
  originLabel,
  PAGE_SIZE,
  pageExists,
  parseSelectionNumber,
  pickerPage,
  selectableCount,
  truncateTitle
} from '../conversation-picker'
import type { ConversationFile, ConversationMessage } from '@main/conversations'

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

// --- fixtures ---------------------------------------------------------

function msg(role: 'user' | 'assistant', content: string, timestamp: number): ConversationMessage {
  return { role, content, timestamp }
}

function conv(
  messages: ConversationMessage[],
  over: Partial<ConversationFile> = {}
): ConversationFile {
  return {
    id: 'conv-test',
    title: 'Test',
    model: null,
    messages,
    createdAt: 1000,
    updatedAt: 2000,
    ...over
  }
}

const contents = (c: { messages: ConversationMessage[] }): string[] =>
  c.messages.map((m) => m.content)

async function run(): Promise<void> {
  // Dynamic so the electron shim above is installed first — a static import
  // would be hoisted above it and crash on workspace.ts's electron.app access.
  const { mergeConversationOnto } = await import('@main/conversations')

  // ── chat-binding: point a chat at the conversation that messaged it ──

  // A tiny in-memory stand-in for one chat's map entry + its conversation file.
  function bindingHarness(opts: { bound: string | null; conv: ConversationFile | null }): {
    io: ChatBindingIO
    writes: () => { set: number; update: number }
    boundTo: () => string | null
    conv: () => ConversationFile | null
  } {
    let bound = opts.bound
    let conv = opts.conv
    let set = 0
    let update = 0
    return {
      io: {
        getBoundConversationId: async () => bound,
        setBoundConversationId: async (id) => {
          set++
          bound = id
        },
        updateConversation: async (id, mutate) => {
          update++
          const next = mutate(conv && conv.id === id ? conv : null)
          if (next) conv = next
        }
      },
      writes: () => ({ set, update }),
      boundTo: () => bound,
      conv: () => conv
    }
  }

  const sending = (over: Partial<ConversationFile> = {}): ConversationFile =>
    conv([msg('user', 'run the job', 1)], { id: 'conv-sender', updatedAt: 1, ...over })

  // The common case by far: a channel turn replying into its own chat. It must
  // be a TRUE no-op — the bind rewrites the conversation file, so doing it on
  // every send would restart the idle clock on a chat nobody moved.
  {
    const h = bindingHarness({ bound: 'conv-sender', conv: sending() })
    const result = await bindChatToConversation('conv-sender', h.io)
    ok('bind: already bound → reported as such', result === 'already-bound')
    ok(
      'bind: already bound → no writes at all',
      h.writes().set === 0 && h.writes().update === 0,
      JSON.stringify(h.writes())
    )
  }

  // The point of the feature: the chat was on some other conversation, and the
  // one that just messaged the user takes it over.
  {
    const h = bindingHarness({ bound: 'conv-something-else', conv: sending() })
    const result = await bindChatToConversation('conv-sender', h.io)
    ok('bind: a chat on another conversation is rebound', result === 'bound')
    ok('bind: the map now points at the sender', h.boundTo() === 'conv-sender')
  }

  // Without the bump the next inbound message trips the staleHours check and
  // rotates to a fresh conversation — bouncing the reply straight out of the
  // conversation we just bound it to.
  {
    const h = bindingHarness({ bound: null, conv: sending({ updatedAt: 1 }) })
    await bindChatToConversation('conv-sender', h.io)
    ok('bind: restarts the idle clock', (h.conv()?.updatedAt ?? 0) > 1)
  }

  // THE headline case, and the one an existence guard silently broke: an
  // automation's conversation lives in memory for the whole run and only hits
  // disk when the run ends, so a heartbeat calling telegram_send mid-run has no
  // file to load. It must still bind — otherwise the reply to "your job
  // finished" lands in an unrelated conversation, which is the entire bug this
  // feature exists to fix.
  {
    const h = bindingHarness({ bound: 'conv-something-else', conv: null })
    const result = await bindChatToConversation('conv-mid-run', h.io)
    ok('bind: a conversation not yet written to disk still binds', result === 'bound', result)
    ok('bind: the map points at the in-flight run', h.boundTo() === 'conv-mid-run')
  }

  // Provenance is never touched — the conversation's channel says where it came
  // from, not who it is talking to.
  {
    const h = bindingHarness({ bound: null, conv: sending({ channel: 'heartbeat' }) })
    await bindChatToConversation('conv-sender', h.io)
    ok('bind: leaves provenance alone', h.conv()?.channel === 'heartbeat')
  }

  // Nothing in scope to bind (a detached run) — never touch the map.
  {
    const h = bindingHarness({ bound: 'conv-something-else', conv: sending() })
    ok(
      'bind: no conversation in scope → no-turn',
      (await bindChatToConversation(null, h.io)) === 'no-turn'
    )
    ok('bind: no conversation in scope → no writes', h.writes().set === 0)
    ok('bind: no conversation in scope → mapping untouched', h.boundTo() === 'conv-something-else')
  }

  // ── mergeConversationOnto: the caller still owns messages ────────────

  // No disk file yet → incoming passes through untouched.
  const fresh = conv([msg('user', 'hi', 1)])
  ok('merge: no disk file → incoming verbatim', mergeConversationOnto(null, fresh) === fresh)

  // The ordinary save: load, append a turn, save. The caller's array wins whole.
  const diskPrefix = conv([msg('user', 'hi', 1), msg('assistant', 'hello', 2)])
  const withTurn = conv([
    msg('user', 'hi', 1),
    msg('assistant', 'hello', 2),
    msg('user', 'more', 3),
    msg('assistant', 'sure', 4)
  ])
  const appended = mergeConversationOnto(diskPrefix, withTurn)
  ok(
    'merge: plain append → incoming messages returned as-is',
    appended.messages === withTurn.messages
  )

  // Identical copies → unchanged.
  const same = conv([msg('user', 'hi', 1), msg('assistant', 'hello', 2)])
  ok(
    'merge: identical copies → no change',
    JSON.stringify(mergeConversationOnto(same, conv(same.messages)).messages) ===
      JSON.stringify(same.messages)
  )

  // The titler writes a shell for the first in-app turn whose messages[0]
  // content is the COMPOSED history string (bare text + the <attachments>
  // block), while the renderer later persists the BARE text. They are the same
  // logical message with different content, which is why the merge must not try
  // to reconcile the two arrays by matching messages: an attempt to do so
  // classed the shell as a separate message and permanently duplicated the
  // opening line of every chat started with an attachment.
  const attachmentShell = conv([
    msg('user', 'what is this?\n\n<attachments>\nphoto.png\n</attachments>', 3000)
  ])
  const rendererBare = conv([msg('user', 'what is this?', 1000), msg('assistant', 'A cat.', 1001)])
  const afterShell = mergeConversationOnto(attachmentShell, rendererBare)
  ok(
    'merge: the titler shell never duplicates the first message',
    afterShell.messages.length === 2,
    `${afterShell.messages.length} messages: ${contents(afterShell).join(' | ')}`
  )
  ok(
    'merge: the persisted first message stays the bare user text',
    afterShell.messages[0].content === 'what is this?'
  )

  // The renderer's load-failure fallback (ensureConversationId) synthesizes a
  // copy with NO channel. Saving that must not erase the conversation's
  // provenance — a Telegram conversation silently reclassified as in-app would
  // vanish from /resume and leave its chat mapping dangling.
  const diskTelegram = conv([msg('user', 'hi', 1)], { channel: 'telegram' })
  const channelless = conv([msg('user', 'hi', 1), msg('assistant', 'reply', 2)])
  ok(
    'merge: a channel-less caller copy cannot erase the channel',
    mergeConversationOnto(diskTelegram, channelless).channel === 'telegram'
  )
  // But a caller that DOES carry a channel still owns it.
  ok(
    'merge: an explicit incoming channel is kept',
    mergeConversationOnto(diskTelegram, conv([msg('user', 'hi', 1)], { channel: 'telegram' }))
      .channel === 'telegram'
  )
  // Unsealing a continued heartbeat run must reach disk (the summarizer skips
  // sealed files, so a continued run would never get a prefix summary).
  const diskSealed = conv([msg('user', 'run', 1)], { channel: 'heartbeat', sealed: true })
  const continuedRun = conv([msg('user', 'run', 1), msg('user', 'follow up', 2)], {
    channel: 'heartbeat',
    sealed: false
  })
  ok(
    'merge: unseal survives the merge',
    mergeConversationOnto(diskSealed, continuedRun).sealed === false
  )

  // The pre-existing merge contract is unchanged.
  const diskSummarized = conv([msg('user', 'hi', 1)], {
    summary: 'disk summary',
    summarizedThroughMessage: 5,
    title: 'Real Title'
  })
  const incomingStale = conv([msg('user', 'hi', 1)], {
    summarizedThroughMessage: 2,
    title: 'Untitled'
  })
  const kept = mergeConversationOnto(diskSummarized, incomingStale)
  ok('merge: disk summary still wins when its mark is ahead', kept.summary === 'disk summary')
  ok('merge: real disk title still beats incoming Untitled', kept.title === 'Real Title')

  // ── picker: numbering ────────────────────────────────────────────────

  ok('keycap: 1', keycapNumber(1) === '1️⃣')
  ok('keycap: 10 keeps its glyph', keycapNumber(10) === '🔟')
  ok('keycap: 26 spells out digits', keycapNumber(26) === '2️⃣6️⃣')
  ok('keycap: 100', keycapNumber(100) === '1️⃣0️⃣0️⃣')

  // ── picker: origin tag (mixed /resume list) ──────────────────────────

  ok('origin: telegram', originLabel('telegram') === 'Telegram')
  ok('origin: whatsapp', originLabel('whatsapp') === 'WhatsApp')
  ok('origin: heartbeat reads as Automated', originLabel('heartbeat') === 'Automated')
  ok('origin: procedure', originLabel('procedure') === 'Procedure')
  ok('origin: in-app (electron) reads as App', originLabel('electron') === 'App')
  ok('origin: absent channel reads as App', originLabel(undefined) === 'App')

  // ── picker: row bounding ─────────────────────────────────────────────

  // Titles are model-written and unbounded; neither channel splits a picker,
  // so an over-long page would just fail to send. A row has to stay bounded.
  ok('title: short titles untouched', truncateTitle('Quick chat') === 'Quick chat')
  ok('title: empty falls back', truncateTitle('') === 'Untitled')
  const long = truncateTitle('X'.repeat(400))
  ok('title: long titles are capped', long.length <= 64, String(long.length))
  ok('title: capped titles are marked with an ellipsis', long.endsWith('…'))

  // A worst-case full page must fit both channels' 4096-char message limit.
  const worstRow = `${keycapNumber(999)} <b>${truncateTitle('X'.repeat(400))}</b>\nyesterday\n9999 messages`
  const worstPage =
    'header'.padEnd(60) + Array.from({ length: PAGE_SIZE }, () => worstRow).join('\n\n')
  ok(`worst-case page fits in 4096 chars (${worstPage.length})`, worstPage.length < 4096)

  // ── picker: selection parsing ────────────────────────────────────────

  ok('parse: bare number', parseSelectionNumber('3') === 3)
  ok('parse: surrounding whitespace', parseSelectionNumber('  26 ') === 26)
  // The old Telegram cap was 2 digits, making every item past 99 unselectable.
  ok('parse: 3 digits (past the old 2-digit cap)', parseSelectionNumber('100') === 100)
  ok('parse: 4 digits', parseSelectionNumber('1234') === 1234)
  // The old WhatsApp parser stripped non-digits from the whole message, so a
  // digit-bearing sentence sent while /delete was pending deleted an item.
  ok(
    'parse: digit-bearing sentence is not a selection',
    parseSelectionNumber('call me at 5') === null
  )
  ok('parse: "send 1 message" is not a selection', parseSelectionNumber('send 1 message') === null)
  ok('parse: words are not a selection', parseSelectionNumber('next') === null)
  ok('parse: zero rejected', parseSelectionNumber('0') === null)
  ok('parse: empty rejected', parseSelectionNumber('') === null)

  // ── picker: the `next` reply ─────────────────────────────────────────

  ok('next: bare word', isNextPageReply('next'))
  ok('next: slash form', isNextPageReply('/next'))
  ok('next: whitespace tolerated', isNextPageReply('  next '))
  ok('next: a real message is not paging', !isNextPageReply('next steps for the project'))
  ok('next: a number is not paging', !isNextPageReply('2'))

  // ── picker: paging arithmetic ────────────────────────────────────────

  ok('page size is 25', PAGE_SIZE === 25)

  const many = Array.from({ length: 87 }, (_, i) => `c${i + 1}`)

  const p0 = pickerPage(many, 0)
  ok('page 0: 25 rows', p0.shown.length === 25)
  ok('page 0: starts at item 1', p0.start === 0)
  ok('page 0: last is 25', p0.last === 25)
  ok('page 0: reports the full total', p0.total === 87)
  ok('page 0: has more', p0.hasMore)

  // The headline requirement: counting continues — page 2 starts at 26.
  const p1 = pickerPage(many, 1)
  ok('page 1: numbering continues at 26', p1.start + 1 === 26)
  ok('page 1: runs to 50', p1.last === 50)
  ok('page 1: first row is the 26th conversation', p1.shown[0] === 'c26')
  ok('page 1: has more', p1.hasMore)

  const p3 = pickerPage(many, 3)
  ok('page 3: partial final page', p3.shown.length === 12)
  ok('page 3: numbering continues at 76', p3.start + 1 === 76)
  ok('page 3: last is the total', p3.last === 87)
  ok('page 3: no more pages', !p3.hasMore)

  // Pages tile the list exactly: no gaps, no duplicates, no drops.
  const tiled: string[] = []
  for (let page = 0; pageExists(many, page); page++) tiled.push(...pickerPage(many, page).shown)
  ok('paging tiles the whole list exactly once', JSON.stringify(tiled) === JSON.stringify(many))

  // A displayed number resolves to the right conversation on every page.
  let numberingCorrect = true
  for (let page = 0; pageExists(many, page); page++) {
    const { shown, start } = pickerPage(many, page)
    shown.forEach((item, i) => {
      const displayed = start + i + 1
      if (many[displayed - 1] !== item) numberingCorrect = false
    })
  }
  ok('displayed number indexes the snapshot correctly on every page', numberingCorrect)

  ok('pageExists: page 3 of 87 exists', pageExists(many, 3))
  ok('pageExists: page 4 of 87 does not', !pageExists(many, 4))
  ok('pageExists: negative page rejected', !pageExists(many, -1))

  // ── picker: only what has been SHOWN is selectable ───────────────────

  // Bounding selection by the snapshot instead of by what was rendered would
  // let "30" typed on page 1 act on a row the user has never seen — and for
  // /delete that is an unrecoverable delete of the wrong conversation.
  ok('selectable: page 1 shows 25 of 87', selectableCount(many, 0) === 25)
  ok('selectable: page 2 extends the range to 50', selectableCount(many, 1) === 50)
  ok('selectable: the final page opens the whole list', selectableCount(many, 3) === 87)
  // Paging only moves forward, so an earlier page's number stays valid.
  ok(
    'selectable: an earlier page number is still selectable from page 2',
    3 <= selectableCount(many, 1)
  )

  // A short list is one page with no footer prompt.
  const few = ['a', 'b', 'c']
  ok(
    'short list: single page',
    !pickerPage(few, 0).hasMore && pickerPage(few, 0).shown.length === 3
  )
  ok('short list: no second page', !pageExists(few, 1))
  ok('short list: fully selectable at once', selectableCount(few, 0) === 3)
  // Exactly PAGE_SIZE items must not offer an empty next page.
  const exact = Array.from({ length: 25 }, (_, i) => `x${i}`)
  ok('exactly one full page: no more', !pickerPage(exact, 0).hasMore)
  ok('exactly one full page: no page 1', !pageExists(exact, 1))

  // ── end-to-end: real conversation logs (read-only) ───────────────────

  const conversationsDir = path.join(
    os.homedir(),
    '.wolffish',
    'workspace',
    'brain',
    'conversations'
  )
  if (!fs.existsSync(conversationsDir)) {
    console.log('\n(skipped real-log pass — no workspace at ' + conversationsDir + ')')
  } else {
    const files = fs.readdirSync(conversationsDir).filter((f) => f.endsWith('.json'))
    const byChannel = new Map<string, number>()
    let replayed = 0
    let identityHolds = true
    let appendHolds = true
    let channelHolds = true
    let firstFailure = ''

    for (const file of files) {
      let real: ConversationFile
      try {
        real = JSON.parse(fs.readFileSync(path.join(conversationsDir, file), 'utf8'))
      } catch {
        continue // a malformed file is loadConversation's problem, not ours
      }
      if (!Array.isArray(real.messages)) continue
      replayed++
      const channel = real.channel ?? '<absent>'
      byChannel.set(channel, (byChannel.get(channel) ?? 0) + 1)

      const original = JSON.stringify(real.messages)

      // 1. Re-saving an untouched copy must change nothing at all. This is the
      //    backward-compat guarantee: every existing conversation, on every
      //    channel, survives the new merge byte-identical. The incoming copy is
      //    deep-cloned so the merge can't pass by sharing the disk array.
      const clone: ConversationFile = { ...real, messages: JSON.parse(original) }
      const identity = mergeConversationOnto(real, clone)
      if (JSON.stringify(identity.messages) !== original) {
        identityHolds = false
        if (!firstFailure) firstFailure = `identity: ${file}`
      }

      // 2. Continuing it from the app — load, append a turn, save — must keep
      //    the whole existing transcript and add the new turn at the end.
      const lastTs = real.messages.reduce((mx, m) => Math.max(mx, m.timestamp ?? 0), 0)
      const continued: ConversationFile = {
        ...real,
        messages: [
          ...(JSON.parse(original) as ConversationMessage[]),
          msg('user', 'continuing from the app', lastTs + 1000),
          msg('assistant', 'continued', lastTs + 2000)
        ]
      }
      const saved = mergeConversationOnto(real, continued)
      if (
        saved.messages.length !== real.messages.length + 2 ||
        JSON.stringify(saved.messages.slice(0, real.messages.length)) !== original
      ) {
        appendHolds = false
        if (!firstFailure) firstFailure = `append: ${file}`
      }

      // 3. The conversation's channel — its provenance — survives an app save
      //    even when the caller copy doesn't carry one (the renderer's
      //    load-failure fallback builds exactly such a copy).
      const noChannel: ConversationFile = { ...continued }
      delete noChannel.channel
      const keptChannel = mergeConversationOnto(real, noChannel)
      if ((real.channel ?? undefined) !== (keptChannel.channel ?? undefined)) {
        channelHolds = false
        if (!firstFailure) firstFailure = `channel: ${file}`
      }
    }

    ok(`real logs: replayed ${replayed} conversation files`, replayed > 0)
    ok('real logs: re-saving an untouched copy changes nothing', identityHolds, firstFailure)
    ok('real logs: continuing from the app keeps the full transcript', appendHolds, firstFailure)
    ok('real logs: an app save cannot erase the conversation channel', channelHolds, firstFailure)
    console.log(
      `  channels seen: ${[...byChannel.entries()].map(([c, n]) => `${c}=${n}`).join(', ')}`
    )

    // Every real conversation, newest-first — the exact list /resume now pages
    // over (it no longer filters to the asking channel).
    const everyConv = files
      .map((f) => {
        try {
          return JSON.parse(
            fs.readFileSync(path.join(conversationsDir, f), 'utf8')
          ) as ConversationFile
        } catch {
          return null
        }
      })
      .filter((c): c is ConversationFile => !!c && Array.isArray(c.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt)

    // CROSSOVER: /resume from any channel reaches every conversation. Page the
    // whole mixed list and assert it tiles exactly — no conversation dropped,
    // duplicated, or reordered across ~27 pages of 25.
    const walked: string[] = []
    for (let page = 0; pageExists(everyConv, page); page++) {
      walked.push(...pickerPage(everyConv, page).shown.map((c) => c.id))
    }
    ok(
      `real logs: /resume pages all ${everyConv.length} conversations with no gaps or repeats`,
      JSON.stringify(walked) === JSON.stringify(everyConv.map((c) => c.id))
    )
    // The list genuinely crosses channels — otherwise "resume from anywhere"
    // would be untested. The real folder holds telegram + whatsapp + heartbeat
    // + procedure + in-app, so the mix must be > 1.
    const distinctChannels = new Set(everyConv.map((c) => c.channel ?? 'app'))
    ok(
      `real logs: the resume list spans multiple origins (${[...distinctChannels].sort().join(', ')})`,
      distinctChannels.size > 1
    )
    // Every displayed number resolves to the right conversation across the
    // whole mixed list — the property a cross-channel resume depends on.
    let mixedNumberingOk = true
    for (let page = 0; pageExists(everyConv, page); page++) {
      const { shown, start } = pickerPage(everyConv, page)
      shown.forEach((c, i) => {
        if (everyConv[start + i]?.id !== c.id) mixedNumberingOk = false
      })
    }
    ok('real logs: a picker number resolves correctly anywhere in the mixed list', mixedNumberingOk)

    // Every real channel value gets a readable origin tag (no "undefined").
    const badOrigin = [...distinctChannels].find(
      (c) => originLabel(c === 'app' ? undefined : c).length === 0
    )
    ok('real logs: every real origin has a label', badOrigin === undefined, badOrigin)

    // NOTE: which conversations each command offers is not asserted here, and
    // deliberately so. renderConversationPicker is a channel-class method —
    // unreachable from this harness — so any check written here would compare
    // this fixture against itself and pass no matter what the picker does.
    // What IS covered above is the machinery the picker delegates to:
    // pickerPage/pageExists tiling, continuous numbering, selectableCount
    // bounds, originLabel, parseSelectionNumber.
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
