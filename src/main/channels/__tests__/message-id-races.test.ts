/**
 * Race matrix for id-keyed conversation reconciliation — the REAL
 * updateConversation/saveConversation/diskWriter queue and the REAL titler,
 * against a throwaway workspace (os.homedir is shimmed to a temp dir before
 * anything imports workspace/root.ts, so ~/.wolffish is never touched).
 *
 *  (a) an in-app end-of-turn whole-file save racing a channel's
 *      dispatch-time user-message append — same-index divergence, the case
 *      count guards cannot see; both messages must survive, both orders,
 *  (b) the titler shell racing the first renderer persist that carries the
 *      SAME threaded user-message id — one user message on disk, bare-text
 *      copy winning, title kept, in every ordering,
 *  (c) the 2026-07-17 replay: a completed 6-message conversation hit by a
 *      stale 2-message whole-file save — nothing may be lost,
 *  (d) interleaved channel appends + in-app continuation saves on one
 *      conversation with a live summary mark — every logical message exactly
 *      once, and the mark still pins the same logical message afterward.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/channels/__tests__/message-id-races.test.ts
 */

import Module from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Shim os.homedir BEFORE any dynamic import evaluates workspace/root.ts —
// its WORKSPACE_ROOT const captures homedir at module scope. tsx compiles to
// CJS, so the real imports below run lazily inside run().
let tmpHome = ''
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'os' || args[0] === 'node:os') {
    const real = origLoad.apply(this, args) as typeof os
    return { ...real, homedir: () => tmpHome, default: { ...real, homedir: () => tmpHome } }
  }
  return origLoad.apply(this, args)
}

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

async function run(): Promise<void> {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-id-races-'))
  const conversations = await import('@main/conversations')
  const {
    mintMessageId,
    saveConversation,
    updateConversation,
    loadConversation,
    createConversation
  } = conversations
  type ConversationFile = import('@main/conversations').ConversationFile
  type ConversationMessage = import('@main/conversations').ConversationMessage
  const { ensureConversationTitle } = await import('@main/conversation-titler')

  const convDir = path.join(tmpHome, '.wolffish', 'workspace', 'brain', 'conversations')
  await fs.mkdir(convDir, { recursive: true })

  const msg = (
    id: string,
    role: 'user' | 'assistant',
    content: string,
    ts = 1_000
  ): ConversationMessage => ({ id, role, content, timestamp: ts })

  const freshConv = (id: string, messages: ConversationMessage[]): ConversationFile => ({
    ...createConversation(null),
    id,
    title: 'T',
    messages
  })

  const readDisk = async (id: string): Promise<ConversationFile> => {
    const conv = await loadConversation(id)
    if (!conv) throw new Error(`conversation ${id} missing from disk`)
    return conv
  }

  /** The channels' dispatch-time persist, byte-for-byte (telegram/whatsapp). */
  const channelAppend = (conversationId: string, message: ConversationMessage): Promise<void> =>
    updateConversation(conversationId, (disk) => {
      if (!disk) return null
      disk.messages.push(message)
      disk.updatedAt = message.timestamp
      return disk
    })

  const idsOf = (c: ConversationFile): string[] => c.messages.map((m) => m.id ?? '<none>')
  const assertUnique = (label: string, c: ConversationFile): void => {
    const ids = idsOf(c)
    ok(`${label}: no duplicate ids on disk`, new Set(ids).size === ids.length, ids.join(','))
  }

  // ── (a) whole-file save racing a channel append, both orders ────────────
  for (const order of ['save-first', 'append-first', 'concurrent'] as const) {
    const id = `race-a-${order}`
    const prefix = [msg('A', 'user', 'q1'), msg('B', 'assistant', 'a1')]
    await saveConversation(
      freshConv(
        id,
        prefix.map((m) => ({ ...m }))
      )
    )

    const channelMsg = msg('C', 'user', 'landed from the phone', 2_000)
    const rendererCopy = freshConv(id, [
      ...prefix.map((m) => ({ ...m })),
      msg('D', 'user', 'renderer question', 2_001),
      msg('E', 'assistant', 'renderer answer', 2_002)
    ])

    if (order === 'save-first') {
      await saveConversation(rendererCopy)
      await channelAppend(id, channelMsg)
    } else if (order === 'append-first') {
      await channelAppend(id, channelMsg)
      await saveConversation(rendererCopy)
    } else {
      await Promise.all([saveConversation(rendererCopy), channelAppend(id, channelMsg)])
    }

    const disk = await readDisk(id)
    assertUnique(`(a) ${order}`, disk)
    ok(
      `(a) ${order}: all five messages survive`,
      disk.messages.length === 5 &&
        ['A', 'B', 'C', 'D', 'E'].every((want) => idsOf(disk).includes(want)),
      idsOf(disk).join(',')
    )
    ok(
      `(a) ${order}: common prefix leads`,
      idsOf(disk)[0] === 'A' && idsOf(disk)[1] === 'B',
      idsOf(disk).join(',')
    )
  }

  // ── (b) REAL titler shell racing the first renderer persist, same id ────
  for (const order of ['shell-first', 'save-first', 'concurrent'] as const) {
    const id = `race-b-${order}`
    const userMessageId = mintMessageId(3_000)
    const stubLlm = { title: async (): Promise<{ text: string }> => ({ text: 'Great Title' }) }
    const composed =
      'bare text\n\n<attachments>\n  - report.pdf (type=pdf, mime=application/pdf, size=1b, path=/x)\n</attachments>'

    const titler = (): Promise<string | undefined> =>
      ensureConversationTitle(id, composed, undefined, stubLlm, undefined, userMessageId)
    const rendererSave = (): Promise<void> =>
      saveConversation(
        freshConv(id, [
          { id: userMessageId, role: 'user', content: 'bare text', timestamp: 3_000 },
          msg('R', 'assistant', 'the answer', 3_001)
        ])
      )

    if (order === 'shell-first') {
      await titler()
      await rendererSave()
    } else if (order === 'save-first') {
      await rendererSave()
      await titler()
    } else {
      await Promise.all([titler(), rendererSave()])
    }

    const disk = await readDisk(id)
    assertUnique(`(b) ${order}`, disk)
    ok(
      `(b) ${order}: exactly one user message + one assistant`,
      disk.messages.length === 2 &&
        disk.messages[0].id === userMessageId &&
        disk.messages[1].id === 'R',
      JSON.stringify(disk.messages.map((m) => [m.id, m.role]))
    )
    ok(
      `(b) ${order}: renderer bare-text copy wins over the composed shell`,
      disk.messages[0].content === 'bare text',
      disk.messages[0].content
    )
    ok(`(b) ${order}: title kept`, disk.title === 'Great Title' || disk.title === 'T', disk.title)
  }

  // ── (c) the 2026-07-17 replay: stale 2-message save over a good 6 ───────
  {
    const id = 'race-c'
    const good = freshConv(id, [
      msg('A', 'user', 'q1'),
      msg('B', 'assistant', 'a1'),
      msg('C', 'user', 'q2'),
      msg('D', 'assistant', 'a2'),
      msg('E', 'user', 'q3'),
      msg('F', 'assistant', 'a3')
    ])
    await saveConversation(good)
    const stale = freshConv(id, [msg('A', 'user', 'q1'), msg('B', 'assistant', 'a1')])
    await saveConversation(stale)
    const disk = await readDisk(id)
    assertUnique('(c)', disk)
    ok(
      '(c) stale shrink save loses nothing',
      idsOf(disk).join(',') === 'A,B,C,D,E,F',
      idsOf(disk).join(',')
    )
  }

  // ── (d) interleaved channel + in-app continuation, mark intact ──────────
  {
    const id = 'race-d'
    const base = freshConv(id, [
      msg('A', 'user', 'q1'),
      msg('B', 'assistant', 'a1'),
      msg('C', 'user', 'q2'),
      msg('D', 'assistant', 'a2')
    ])
    base.summary = 'covers q1/a1'
    base.summarizedThroughMessage = 2
    base.summarizedThroughMessageId = 'C'
    await saveConversation(base)

    // The in-app continuation holds a copy from open time; two channel
    // messages land while its turn runs; its end-of-turn whole save races
    // the second one.
    const rendererCopy = freshConv(id, [
      ...base.messages.map((m) => ({ ...m })),
      msg('G', 'user', 'in-app follow-up', 4_000),
      msg('H', 'assistant', 'in-app reply', 4_001)
    ])
    rendererCopy.summary = base.summary
    rendererCopy.summarizedThroughMessage = 2
    rendererCopy.summarizedThroughMessageId = 'C'

    await channelAppend(id, msg('E', 'user', 'phone message 1', 3_900))
    await Promise.all([
      saveConversation(rendererCopy),
      channelAppend(id, msg('F', 'assistant', 'phone reply 1', 3_901))
    ])

    const disk = await readDisk(id)
    assertUnique('(d)', disk)
    ok(
      '(d) every logical message exactly once',
      disk.messages.length === 8 &&
        ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].every((want) => idsOf(disk).includes(want)),
      idsOf(disk).join(',')
    )
    const markIdx = disk.messages.findIndex((m) => m.id === disk.summarizedThroughMessageId)
    ok(
      '(d) summary mark still pins the same logical message',
      disk.summarizedThroughMessageId === 'C' &&
        markIdx >= 0 &&
        disk.summarizedThroughMessage === markIdx,
      `id=${disk.summarizedThroughMessageId} numeric=${disk.summarizedThroughMessage} actual=${markIdx}`
    )
    ok('(d) summary text kept', disk.summary === 'covers q1/a1', String(disk.summary))
  }

  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
