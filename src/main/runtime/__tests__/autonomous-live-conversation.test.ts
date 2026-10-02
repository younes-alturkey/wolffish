/**
 * The disk contract of a LIVE automation/procedure run (Agent.processAutonomous).
 *
 * The run no longer writes its conversation once, at the end — it writes a
 * shell BEFORE the turn starts, progress snapshots WHILE it runs, and the
 * final message when it ends, all under stable message ids. That sequence
 * goes through the real saveConversation / mergeConversationOnto / diskWriter
 * queue, so it is the one thing worth replaying for real: a re-minted id or a
 * losing race would duplicate the prompt (or lose the answer) in every
 * automation conversation.
 *
 * Replays the exact writes processAutonomous performs, against a throwaway
 * workspace (os.homedir is shimmed to a temp dir before anything imports
 * workspace/root.ts, so ~/.wolffish is never touched).
 *
 *  (a) full run: shell → progress ×2 → final,
 *  (b) quit mid-run: shell → progress, then nothing (the resumable state),
 *      followed by a renderer continuation save,
 *  (c) a progress save racing the final save, both orders,
 *  (d) failed run before any output: shell → final with no assistant,
 *  (e) failed run AFTER output: the partial answer must survive the final
 *      save's shorter message list.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/autonomous-live-conversation.test.ts
 */

import Module from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// Shim os.homedir BEFORE any dynamic import evaluates workspace/root.ts — its
// WORKSPACE_ROOT const captures homedir at module scope. tsx compiles to CJS,
// so the real imports below run lazily inside run().
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
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'wolffish-autorun-'))
  const conversations = await import('@main/conversations')
  const { mintMessageId, saveConversation, loadConversation, createConversation } = conversations
  type ConversationFile = import('@main/conversations').ConversationFile
  type ConversationMessage = import('@main/conversations').ConversationMessage
  type Segment = import('@main/runtime/broca').Segment
  const { buildAssistantMessage } = await import('@main/channels/channel')
  type AssistantAccumulator = import('@main/channels/channel').AssistantAccumulator

  const convDir = path.join(tmpHome, '.wolffish', 'workspace', 'brain', 'conversations')
  await fs.mkdir(convDir, { recursive: true })

  const readDisk = async (id: string): Promise<ConversationFile> => {
    const conv = await loadConversation(id)
    if (!conv) throw new Error(`conversation ${id} missing from disk`)
    return conv
  }
  const idsOf = (c: ConversationFile): string[] => c.messages.map((m) => m.id ?? '<none>')
  const assertUnique = (label: string, c: ConversationFile): void => {
    const ids = idsOf(c)
    ok(`${label}: no duplicate ids on disk`, new Set(ids).size === ids.length, ids.join(','))
  }

  /**
   * One run's writers, mirroring processAutonomous exactly: the same conv
   * object, the same single userMsg, the same accumulator behind both the
   * mirror and every save.
   */
  const makeRun = (
    id: string,
    instruction: string
  ): {
    conv: ConversationFile
    userMsg: ConversationMessage
    acc: AssistantAccumulator
    segments: Segment[]
    saveShell: () => Promise<void>
    saveProgress: () => Promise<void>
    saveFinal: (stopReason?: ConversationMessage['stopReason']) => Promise<void>
  } => {
    const conv: ConversationFile = {
      ...createConversation(null),
      id,
      title: `Daily (08:00): ${instruction}`,
      channel: 'heartbeat',
      sealed: true
    }
    const userMsg: ConversationMessage = {
      id: mintMessageId(conv.createdAt),
      role: 'user',
      content: instruction,
      timestamp: conv.createdAt
    }
    const segments: Segment[] = []
    let progressWrite: Promise<void> | null = null
    const acc: AssistantAccumulator = {
      assistantMessageId: mintMessageId(),
      assistantTimestamp: Date.now(),
      assistantContent: '',
      segments,
      approvals: new Map(),
      toolTimings: new Map(),
      stopReason: null
    }
    return {
      conv,
      userMsg,
      acc,
      segments,
      saveShell: () => {
        conv.messages = [userMsg]
        return saveConversation(conv)
      },
      saveProgress: () => {
        const message = buildAssistantMessage(acc)
        if (!message) return Promise.resolve()
        progressWrite = saveConversation({
          ...conv,
          messages: [userMsg, message],
          updatedAt: Date.now()
        })
          .catch(() => undefined)
          .finally(() => {
            progressWrite = null
          })
        return progressWrite
      },
      saveFinal: async (stopReason) => {
        if (stopReason) acc.stopReason = stopReason
        const message = buildAssistantMessage(acc)
        conv.messages = message ? [userMsg, message] : [userMsg]
        conv.updatedAt = Date.now()
        conv.stats = {
          contextTokens: 1234,
          maxContextTokens: 200_000,
          usage: [],
          updatedAt: Date.now()
        } as unknown as ConversationFile['stats']
        // The real persistRun waits on any in-flight snapshot before writing.
        if (progressWrite) await progressWrite
        return saveConversation(conv)
      }
    }
  }

  const say = (acc: AssistantAccumulator, segments: Segment[], text: string): void => {
    segments.push({ kind: 'text', delta: text } as Segment)
    acc.assistantContent += text
  }

  // ── (a) full run: shell → progress ×2 → final ───────────────────────────
  {
    const r = makeRun('auto-a', 'Summarize unread email')
    await r.saveShell()
    let disk = await readDisk('auto-a')
    ok(
      '(a) shell exists before the turn produces anything',
      disk.messages.length === 1 && disk.messages[0].content === 'Summarize unread email',
      JSON.stringify(idsOf(disk))
    )
    ok(
      '(a) shell keeps the title',
      disk.title === 'Daily (08:00): Summarize unread email',
      disk.title
    )
    ok('(a) shell keeps the channel', disk.channel === 'heartbeat', String(disk.channel))

    say(r.acc, r.segments, 'Checking')
    await r.saveProgress()
    say(r.acc, r.segments, ' the inbox…')
    await r.saveProgress()
    disk = await readDisk('auto-a')
    assertUnique('(a) mid-run', disk)
    ok(
      '(a) progress saves keep exactly prompt + one growing answer',
      disk.messages.length === 2 && disk.messages[1].content === 'Checking the inbox…',
      JSON.stringify(disk.messages.map((m) => [m.id, m.role, m.content]))
    )

    say(r.acc, r.segments, ' Done: 3 unread.')
    await r.saveFinal('end_turn')
    disk = await readDisk('auto-a')
    assertUnique('(a) final', disk)
    ok(
      '(a) final: still exactly two messages',
      disk.messages.length === 2,
      JSON.stringify(disk.messages.map((m) => [m.id, m.role]))
    )
    ok(
      '(a) final: the prompt id never changed',
      disk.messages[0].id === r.userMsg.id,
      `${disk.messages[0].id} vs ${r.userMsg.id}`
    )
    ok(
      '(a) final: the answer id never changed',
      disk.messages[1].id === r.acc.assistantMessageId,
      `${disk.messages[1].id} vs ${r.acc.assistantMessageId}`
    )
    ok(
      '(a) final: full answer wins over the last snapshot',
      disk.messages[1].content === 'Checking the inbox… Done: 3 unread.',
      disk.messages[1].content
    )
    ok('(a) final: stopReason recorded', disk.messages[1].stopReason === 'end_turn')
    ok('(a) final: stats persisted', Boolean(disk.stats))
    ok('(a) final: segments persisted', (disk.messages[1].segments ?? []).length === 3)
  }

  // ── (b) quit mid-run, then resume from the app ──────────────────────────
  {
    const r = makeRun('auto-b', 'Draft the weekly report')
    await r.saveShell()
    say(r.acc, r.segments, 'Gathering the numbers')
    await r.saveProgress()
    // …app quits here: no final save ever runs.
    let disk = await readDisk('auto-b')
    ok(
      '(b) an interrupted run leaves a resumable transcript',
      disk.messages.length === 2 &&
        disk.messages[0].content === 'Draft the weekly report' &&
        disk.messages[1].content === 'Gathering the numbers',
      JSON.stringify(disk.messages.map((m) => [m.role, m.content]))
    )

    // The user reopens it and continues — the renderer's whole-file save.
    const continued: ConversationFile = {
      ...disk,
      messages: [
        ...disk.messages,
        { id: mintMessageId(), role: 'user', content: 'keep going', timestamp: Date.now() },
        { id: mintMessageId(), role: 'assistant', content: 'Resumed.', timestamp: Date.now() }
      ]
    }
    await saveConversation(continued)
    disk = await readDisk('auto-b')
    assertUnique('(b) continued', disk)
    ok(
      '(b) continuation keeps the interrupted run and appends',
      disk.messages.length === 4 && disk.messages[3].content === 'Resumed.',
      JSON.stringify(disk.messages.map((m) => [m.role, m.content]))
    )
  }

  // ── (c) a progress save racing the final save, both orders ──────────────
  for (const order of ['progress-first', 'concurrent'] as const) {
    const id = `auto-c-${order}`
    const r = makeRun(id, 'Check the deploy')
    await r.saveShell()
    say(r.acc, r.segments, 'partial')

    // The final answer is appended AFTER the progress save is issued, so the
    // in-flight snapshot is stale by construction. Whichever order the two
    // writes settle in, the snapshot must never be the copy left on disk.
    const progress = r.saveProgress()
    say(r.acc, r.segments, ' + complete')
    if (order === 'progress-first') await progress
    const final = r.saveFinal('end_turn')
    await Promise.all([progress, final])

    const disk = await readDisk(id)
    assertUnique(`(c) ${order}`, disk)
    ok(
      `(c) ${order}: the stale snapshot never wins`,
      disk.messages.length === 2 && disk.messages[1].content === 'partial + complete',
      JSON.stringify(disk.messages.map((m) => [m.role, m.content]))
    )
  }

  // ── (d) failure before any output ───────────────────────────────────────
  {
    const r = makeRun('auto-d', 'Call an API that is down')
    await r.saveShell()
    await r.saveFinal('end_turn')
    const disk = await readDisk('auto-d')
    ok(
      '(d) a run that produced nothing keeps just the instruction',
      disk.messages.length === 1 && disk.messages[0].role === 'user',
      JSON.stringify(disk.messages.map((m) => [m.role, m.content]))
    )
    ok('(d) failed run still lands in history', disk.title.startsWith('Daily (08:00):'), disk.title)
  }

  // ── (e) failure AFTER output — the partial answer must survive ──────────
  {
    const r = makeRun('auto-e', 'Long job that throws late')
    await r.saveShell()
    say(r.acc, r.segments, 'got this far')
    await r.saveProgress()
    // The throw path persists whatever the accumulator holds; if it ever
    // rebuilt an empty message, the merge's shrink guard is the last line of
    // defence for the partial answer.
    await r.saveFinal('end_turn')
    const disk = await readDisk('auto-e')
    ok(
      '(e) partial answer survives a failed run',
      disk.messages.length === 2 && disk.messages[1].content === 'got this far',
      JSON.stringify(disk.messages.map((m) => [m.role, m.content]))
    )
  }

  await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => undefined)
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void run()
