/**
 * Does a CLI turn actually reach the desktop while it is still running?
 *
 * The report was "text in the CLI, nothing in the app, then it synced at the
 * end" — which is what a broken live mirror looks like, and also what a
 * WORKING mirror looks like when the conversation is not the one on screen.
 * Those need telling apart, so this drives a real CliChannel through a stub
 * runner and asserts on the mirror calls themselves rather than on a window.
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx \
 *        src/main/channels/__tests__/cli-mirror.test.ts
 */
import type { TurnSendOptions } from '@main/channels/turn-runner'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wolffish-cli-mirror-'))
const realHomedir = os.homedir
;(os as { homedir: () => string }).homedir = () => TMP
fs.mkdirSync(path.join(TMP, '.wolffish', 'workspace', 'brain', 'conversations'), {
  recursive: true
})

let passed = 0
let failed = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message : String(err)}`)
  }
}

type MirrorCall = { conversationId: string; message: unknown; userMessage: unknown }

async function main(): Promise<void> {
  const { CliChannel } = await import('@main/channels/cli/channel')
  type Sink = ReturnType<TurnSendOptions['makeSink']>

  // A stub runner that hands back the sink it was given, so the test can drive
  // segments through the exact object the real TurnRunner would drive.
  let capturedSink: Sink | null = null
  let capturedOpts: TurnSendOptions | null = null
  const runner = {
    send(opts: TurnSendOptions) {
      capturedOpts = opts
      capturedSink = opts.makeSink({
        turnId: 'turn_test_1',
        conversationId: opts.conversationId ?? null
      })
      return {
        turnId: 'turn_test_1',
        controller: new AbortController(),
        done: new Promise<void>(() => undefined) // never settles; the turn stays "live"
      }
    }
  }
  const agent = { motor: { stopTask: async () => undefined } }

  const channel = new CliChannel(agent as never, runner as never)
  const mirrors: MirrorCall[] = []
  channel.setMessageMirror((conversationId, message, userMessage) => {
    mirrors.push({ conversationId, message, userMessage })
  })

  const started = await channel.send({ text: 'why is the disk full' })

  check('send creates a conversation and returns its id', () => {
    assert.ok(started.conversationId, 'no conversation id')
    assert.equal(started.turnId, 'turn_test_1')
  })

  // The user message must be on disk BEFORE the turn runs — that is what lets
  // the app (and the phone) show the prompt while the answer is still being
  // written, instead of a bare "assistant is typing" under nothing.
  check('the prompt is persisted before the turn starts', () => {
    const dir = path.join(TMP, '.wolffish', 'workspace', 'brain', 'conversations')
    const files: string[] = []
    const walk = (d: string): void => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(dir)
    const body = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
    assert.ok(body.includes('why is the disk full'), 'prompt not found on disk')
  })

  check('the turn is registered before any segment can arrive', () => {
    // The mirror refuses to emit for an unregistered turn. If registration
    // happened after runner.send() resolved asynchronously, every early
    // segment would be silently dropped — the exact "nothing in the app until
    // the end" symptom.
    assert.ok(channel.isConversationActive(started.conversationId), 'turn not registered')
  })

  check('the channel identifies as cli', () => {
    assert.equal(capturedSink?.channelId, 'cli')
    assert.equal(capturedOpts?.channel, 'cli')
  })

  // ── the live mirror ───────────────────────────────────────────────────────
  const sink = capturedSink as unknown as Sink
  sink.onSegment({
    kind: 'text',
    turnId: 'turn_test_1',
    segmentId: 's1',
    delta: 'Journald is holding 41 GB.'
  })

  check('the first token mirrors immediately — no throttle on the leading edge', () => {
    assert.equal(mirrors.length, 1, `expected 1 mirror, got ${mirrors.length}`)
    assert.equal(mirrors[0].conversationId, started.conversationId)
  })

  check('the mirrored message carries the prose', () => {
    const message = mirrors[0].message as { content: string; role: string; id: string }
    assert.equal(message.role, 'assistant')
    assert.ok(message.content.includes('Journald'), `content was: ${message.content}`)
    assert.ok(message.id, 'no stable id — the app would append instead of upserting')
  })

  check('the prompt rides every tick, for a viewer that joined mid-turn', () => {
    const userMessage = mirrors[0].userMessage as { content: string } | undefined
    assert.ok(userMessage, 'no user message on the mirror tick')
    assert.equal(userMessage.content, 'why is the disk full')
  })

  const firstId = (mirrors[0].message as { id: string }).id

  // Throttled ticks are the point — a fast stream must not repaint per token.
  sink.onSegment({
    kind: 'text',
    turnId: 'turn_test_1',
    segmentId: 's2',
    delta: ' Vacuum it.'
  })
  check('a burst inside the throttle window does not emit again', () => {
    assert.equal(mirrors.length, 1, 'mirrored per token — the app would thrash')
  })

  // A task card flushes immediately: those represent minutes of work, and
  // waiting out a text throttle to show one would defeat the purpose.
  sink.onSegment({
    kind: 'task',
    turnId: 'turn_test_1',
    segmentId: 's3',
    snapshot: {
      kind: 'video',
      taskId: 'task1',
      conversationId: started.conversationId,
      title: 'Render video',
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      estimateSeconds: 90
    }
  })
  check('a task card flushes immediately, past the throttle', () => {
    assert.equal(mirrors.length, 2, 'task card waited for the text throttle')
  })

  check('every tick keeps the SAME message id, so the app upserts one bubble', () => {
    const ids = new Set(mirrors.map((m) => (m.message as { id: string }).id))
    assert.deepEqual([...ids], [firstId], 'id changed mid-turn — the app would duplicate')
  })

  check('accumulated text survives across ticks', () => {
    const last = mirrors[mirrors.length - 1].message as { content: string }
    assert.ok(last.content.includes('Journald'), 'lost the first delta')
    assert.ok(last.content.includes('Vacuum'), 'lost the throttled delta')
  })

  // ── the fold: context-meter stats reach disk ─────────────────────────────
  // The renderer builds `stats` itself for in-app turns; a terminal has no
  // renderer, so the channel must fold the relayed usage events in at the
  // fold — otherwise the app reopens this conversation with a blank meter.
  sink.onTurnEvent('context.built', {
    tokenCount: 1200,
    tokenBudget: 200000,
    compactionAt: 150000,
    sectionsIncluded: []
  })
  sink.onTurnEvent('llm.response', {
    provider: 'anthropic',
    model: 'claude-test',
    role: 'brain',
    inputTokens: 1000,
    outputTokens: 50,
    cacheCreationTokens: 200,
    cacheReadTokens: 300,
    durationMs: 800
  })
  sink.onTurnEvent('turn.usage', {
    provider: 'anthropic',
    model: 'claude-test',
    role: 'brain',
    iterations: 1,
    toolCalls: 2,
    inputTokens: 1000,
    outputTokens: 50,
    cacheCreationTokens: 200,
    cacheReadTokens: 300,
    cacheHitRate: 0.2,
    cost: 0.0123
  })
  const doneFrame = new Promise<void>((resolve) => {
    channel.subscribe((event) => {
      if (event.t === 'done' && event.turnId === 'turn_test_1') resolve()
    })
  })
  sink.onDone()
  await doneFrame
  const { loadConversation } = await import('@main/conversations')
  const saved = await loadConversation(started.conversationId)

  check('the reply is persisted at the fold', () => {
    assert.ok(
      saved?.messages.some((m) => m.role === 'assistant'),
      'no assistant on disk'
    )
  })
  check('the context-meter stats are persisted with the reply', () => {
    const stats = saved?.stats
    assert.ok(stats, 'stats missing — the app would show a blank meter')
    assert.equal(stats.meter?.contextTokens, 1500, 'meter = in + cacheRead + cacheWrite')
    assert.equal(stats.meter?.contextBudget, 200000)
    assert.equal(stats.meter?.compactionAt, 150000)
    assert.equal(stats.meter?.model, 'claude-test')
    assert.equal(stats.lastTurn?.apiCalls, 1)
    assert.equal(stats.lastTurn?.toolCalls, 2, 'turn.usage tool count is authoritative')
    assert.equal(stats.lastTurn?.cost, 0.0123)
    assert.equal(stats.allTime.turns, 1)
    assert.equal(stats.allTime.inputTokens, 1000)
    assert.equal(stats.allTime.outputTokens, 50)
  })
  ;(os as { homedir: () => string }).homedir = realHomedir
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

void main()
