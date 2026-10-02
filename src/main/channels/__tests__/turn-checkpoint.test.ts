/**
 * Mid-turn checkpoint tests — the durability floor for an in-app turn.
 *
 * The bug these pin: an in-app turn reached disk exactly once, at the fold
 * (the renderer's conversation:save on chat:done). A forty-minute run with ten
 * tool calls had written NOTHING; a Windows restart mid-run left the
 * conversation holding only the titler shell's copy of the first prompt, and
 * on a second turn not even that. What is asserted here is that the turn is on
 * disk while it runs, and that being on disk early costs the fold nothing:
 * same ids, one message, richer copy wins.
 *
 * Real disk, sandboxed HOME — the write queue and the id-keyed merge are the
 * things under test, so faking them would test nothing.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/turn-checkpoint.test.ts
 */

import type { ConversationMessage } from '@main/conversations'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// workspaceRoot() reads os.homedir() at module import — override first.
const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'wolffish-turn-checkpoint-'))
process.env.HOME = SANDBOX
process.env.USERPROFILE = SANDBOX

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

const USER_ID = 'm_1_user'
const ASSISTANT_ID = 'm_2_assistant'

function userMessage(content = 'fix my windows display language'): ConversationMessage {
  return { id: USER_ID, role: 'user', content, timestamp: 1000 }
}

/** The accumulator's view of the turn, as far as it has got. */
function assistantSoFar(text: string, extraSegments: number = 0): ConversationMessage {
  const segments = [
    { kind: 'text' as const, turnId: 't1', segmentId: 's1', delta: text },
    ...Array.from({ length: extraSegments }, (_, i) => ({
      kind: 'tool_call' as const,
      turnId: 't1',
      segmentId: `s_tool_${i}`,
      toolCallId: `tc_${i}`,
      name: 'shell_exec',
      args: {}
    }))
  ]
  return {
    id: ASSISTANT_ID,
    role: 'assistant',
    content: text,
    timestamp: 2000,
    segments: segments as ConversationMessage['segments']
  }
}

type Checkpointer = InstanceType<typeof import('@main/channels/turn-checkpoint').TurnCheckpoint>

async function run(): Promise<void> {
  const { TurnCheckpoint, checkpointConversationMessages } =
    await import('@main/channels/turn-checkpoint')
  const { loadConversation, saveConversation } = await import('@main/conversations')
  const { ensureConversationTitle } = await import('@main/conversation-titler')

  function makeCheckpoint(
    conversationId: string,
    assistant: () => ConversationMessage | null,
    live = { value: true }
  ): Checkpointer {
    return new TurnCheckpoint(
      conversationId,
      { channel: 'electron', projectId: null },
      userMessage(),
      assistant,
      () => live.value
    )
  }

  // ── 1. The prompt lands before the first token, on a conversation with no file ──
  {
    const id = 'conv-prompt-first'
    const cp = makeCheckpoint(id, () => null)
    cp.promptNow()
    await cp.flush()
    const disk = await loadConversation(id)
    ok(
      'prompt-only checkpoint seeds the file with the user message',
      disk?.messages.length === 1 && disk.messages[0].id === USER_ID,
      JSON.stringify(disk?.messages.map((m) => m.id))
    )
    ok('seeded file carries the channel', disk?.channel === 'electron', String(disk?.channel))
  }

  // ── 2. Mid-turn assistant copy is written, and marked interrupted ──
  {
    const id = 'conv-midturn'
    let text = 'Checking your display language'
    const cp = makeCheckpoint(id, () => assistantSoFar(text))
    await cp.flush()
    let disk = await loadConversation(id)
    ok(
      'mid-turn checkpoint writes prompt + partial answer',
      disk?.messages.length === 2 && disk.messages[1].id === ASSISTANT_ID,
      JSON.stringify(disk?.messages.map((m) => m.id))
    )
    ok(
      'a mid-turn copy is marked interrupted',
      disk?.messages[1].interrupted === true,
      JSON.stringify(disk?.messages[1].interrupted)
    )

    // A later tick REPLACES the same message rather than appending a second one.
    text = 'Checking your display language. Found it: the region is Arabic.'
    await cp.flush()
    disk = await loadConversation(id)
    ok(
      'a later checkpoint replaces by id — never appends',
      disk?.messages.length === 2 && disk.messages[1].content === text,
      JSON.stringify(disk?.messages.map((m) => [m.id, m.content?.slice(0, 20)]))
    )
  }

  // ── 3. Nothing changed ⇒ no write (no updatedAt churn, no sync push) ──
  {
    const id = 'conv-noop'
    const cp = makeCheckpoint(id, () => assistantSoFar('stable'))
    await cp.flush()
    const first = await loadConversation(id)
    await new Promise((r) => setTimeout(r, 5))
    await cp.flush()
    const second = await loadConversation(id)
    ok(
      'an unchanged flush does not rewrite the file',
      first?.updatedAt === second?.updatedAt,
      `${first?.updatedAt} vs ${second?.updatedAt}`
    )
  }

  // ── 4. The fold replaces the checkpoint — one message, richer copy, no mark ──
  {
    const id = 'conv-fold'
    const cp = makeCheckpoint(id, () => assistantSoFar('partial answer', 1))
    await cp.flush()

    // What the renderer saves at chat:done: the same two ids, the complete
    // answer, plus the approval cards and tool timings only it collects.
    await saveConversation({
      id,
      title: 'Fix Windows English UI',
      model: null,
      createdAt: 1000,
      updatedAt: 3000,
      messages: [
        userMessage(),
        {
          ...assistantSoFar('the complete answer', 2),
          approvals: { tc_0: { toolCallId: 'tc_0', decision: 'approved' } } as never,
          toolTimings: { tc_0: { startedAt: 1, endedAt: 2 } } as never,
          stopReason: 'end_turn'
        }
      ]
    })

    const disk = await loadConversation(id)
    ok(
      'the fold leaves ONE assistant message, not two',
      disk?.messages.length === 2 &&
        disk.messages.filter((m) => m.role === 'assistant').length === 1,
      JSON.stringify(disk?.messages.map((m) => [m.id, m.role]))
    )
    ok(
      'the fold wins on content',
      disk?.messages[1].content === 'the complete answer',
      disk?.messages[1].content
    )
    ok(
      'the interrupted mark is gone once the turn folded',
      disk?.messages[1].interrupted === undefined,
      JSON.stringify(disk?.messages[1].interrupted)
    )
    ok('the fold keeps its approvals', !!disk?.messages[1].approvals?.tc_0)

    // ── 5. A checkpoint that lands AFTER the fold stands down completely. The
    //       renderer's copy is the richer one — approval cards, tool timings,
    //       and the subagent `worker` segments the accumulator never collects
    //       — and the cleared `interrupted` mark is how this writer knows.
    await cp.flush({ final: true })
    const after = await loadConversation(id)
    ok(
      'a checkpoint landing after the fold keeps the fold verbatim',
      JSON.stringify(after?.messages) === JSON.stringify(disk?.messages),
      JSON.stringify(after?.messages[1])
    )
    ok(
      'a checkpoint landing after the fold preserves approvals',
      !!after?.messages[1].approvals?.tc_0,
      JSON.stringify(after?.messages[1].approvals)
    )
    ok(
      'a checkpoint landing after the fold preserves tool timings',
      !!after?.messages[1].toolTimings?.tc_0,
      JSON.stringify(after?.messages[1].toolTimings)
    )
    ok(
      'a checkpoint landing after the fold cannot re-mark it interrupted',
      after?.messages[1].interrupted === undefined
    )
  }

  // ── 5b. The prompt is written once and never rewritten — this writer's copy
  //        is reconstructed from the wire history and is never the better one.
  {
    const id = 'conv-prompt-immutable'
    const cp = makeCheckpoint(id, () => null)
    await cp.flush()
    await checkpointConversationMessages(id, [
      { id: USER_ID, role: 'user', content: 'a rewritten prompt', timestamp: 9999 }
    ])
    const disk = await loadConversation(id)
    ok(
      'an existing user message is never rewritten by a checkpoint',
      disk?.messages[0].content === 'fix my windows display language',
      disk?.messages[0].content
    )
  }

  // ── 6. A released turn's trailing tick is refused; a final flush is not ──
  {
    const id = 'conv-released'
    const live = { value: true }
    const cp = makeCheckpoint(id, () => assistantSoFar('first'), live)
    await cp.flush()
    live.value = false
    const before = await loadConversation(id)
    const cpDead = makeCheckpoint(id, () => assistantSoFar('a stale trailing tick'), live)
    await cpDead.flush()
    const after = await loadConversation(id)
    ok(
      'a tick from a released turn writes nothing',
      before?.messages[1].content === after?.messages[1].content,
      `${before?.messages[1].content} vs ${after?.messages[1].content}`
    )
    await cpDead.flush({ final: true })
    const final = await loadConversation(id)
    ok(
      'a FINAL flush still lands after release — that is the release path',
      final?.messages[1].content === 'a stale trailing tick',
      final?.messages[1].content
    )
  }

  // ── 7. The regression itself: turn TWO's prompt reaches disk before the fold ──
  {
    const id = 'conv-second-turn'
    // Turn one, folded normally.
    await saveConversation({
      id,
      title: 'Fix Windows English UI and reversed mouse',
      model: null,
      createdAt: 1000,
      updatedAt: 1000,
      channel: 'electron',
      messages: [userMessage('first prompt'), assistantSoFar('first answer')]
    })
    // Turn two starts. The titler early-returns on an already-titled file, so
    // before this fix NOTHING wrote the second prompt until the fold.
    await checkpointConversationMessages(
      id,
      [{ id: 'm_3_user', role: 'user', content: 'mouse pointer is weird', timestamp: 4000 }],
      { channel: 'electron' }
    )
    const disk = await loadConversation(id)
    ok(
      "turn two's prompt is on disk before its turn ends",
      disk?.messages.length === 3 && disk.messages[2].id === 'm_3_user',
      JSON.stringify(disk?.messages.map((m) => m.id))
    )
    ok(
      'checkpointing an existing conversation leaves its title alone',
      disk?.title === 'Fix Windows English UI and reversed mouse',
      disk?.title
    )
  }

  // ── 8. A checkpoint-seeded file is still titled by the titler ──
  {
    const id = 'conv-titler-interop'
    const cp = makeCheckpoint(id, () => null)
    await cp.flush()
    await ensureConversationTitle(
      id,
      'fix my windows display language',
      'electron',
      { title: async () => ({ text: 'Windows Display Language' }) },
      undefined,
      USER_ID
    )
    const disk = await loadConversation(id)
    ok(
      'the titler names a checkpoint-seeded file',
      disk?.title === 'Windows Display Language',
      disk?.title
    )
    ok(
      'the titler does not duplicate the checkpointed prompt',
      disk?.messages.length === 1 && disk.messages[0].id === USER_ID,
      JSON.stringify(disk?.messages.map((m) => m.id))
    )
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void run()
