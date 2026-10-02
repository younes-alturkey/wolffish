/**
 * The stream stall watchdog (thalamus STREAM_STALL_MS).
 *
 * Observed 2026-09-15 on deepseek-flash: one call sat silent for 10m23s and
 * returned a single token, another for 4m10s and returned nothing; the
 * provider's only guard was a 3-minute CONNECT timeout, so an open-but-dead
 * stream hung the turn until the provider gave up. Meanwhile the driver
 * session under computer use expired.
 *
 * Contract under test, with a real Thalamus and a fake provider:
 *  1. No chunk for the window → the request is aborted, the turn ends with
 *     the `stalled` reason (an error card with Continue), and NOTHING is
 *     retried — silence is the person's call.
 *  2. A slow-but-alive stream (chunks arriving under the window) never trips
 *     it: the timer re-arms on every chunk.
 *  3. The user's own Stop is not mistaken for a stall.
 *  4. The local model is exempt (prompt evaluation on a slow machine can be
 *     silent for longer than any sane window).
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.node.json npx tsx src/main/runtime/__tests__/stream-stall.test.ts
 */
import assert from 'node:assert/strict'
import Module from 'node:module'
import type { ChatMessage, ProviderStreamOptions, StreamChunk } from '../thalamus'

// Patch BEFORE any value-import of thalamus.ts — tsx/esbuild hoists static
// `import` to the top of the CJS output, which would load electron first
// and leave net.isOnline undefined. Dynamic import below runs after this.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return { net: { isOnline: () => true } }
  }
  return origLoad.apply(this, args)
}

let n = 0
const check = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      n++
      console.log(`✅ ${name}`)
    })
    .catch((err: unknown) => {
      n++
      console.log(`❌ ${name}: ${(err as Error).message}`)
      process.exitCode = 1
    })

/** Waits until the signal aborts, then throws the AbortError a real fetch would. */
function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    }
    if (!signal) return
    if (signal.aborted) return fail()
    signal.addEventListener('abort', fail, { once: true })
  })
}

class FakeProvider {
  calls = 0
  constructor(private readonly behaviour: 'silent' | 'slow' | 'silent-after-text') {}
  async *stream(options: ProviderStreamOptions): AsyncGenerator<StreamChunk> {
    this.calls++
    if (this.behaviour === 'slow') {
      // Four chunks, each arriving after a pause shorter than the window.
      for (let i = 0; i < 4; i++) {
        await new Promise((r) => setTimeout(r, 60))
        yield { type: 'text', text: `t${i} ` }
      }
      yield {
        type: 'turn_meta',
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 4 }
      }
      return
    }
    if (this.behaviour === 'silent-after-text') {
      yield { type: 'text', text: 'partial ' }
    }
    await untilAborted(options.signal)
  }
}

async function main(): Promise<void> {
  const { LocalProvider } = await import('../providers/local')
  const { Thalamus, STREAM_STALL_REASON } = await import('../thalamus')

  const make = (fake: FakeProvider, stallTimeoutMs: number): InstanceType<typeof Thalamus> => {
    const t = new Thalamus(new LocalProvider(), { testProvider: fake, stallTimeoutMs })
    t.setCloudProviders([{ id: 'xai', model: 'grok-4.6', apiKey: 'test-key' }])
    t.setBrain({ providerId: 'xai', model: 'grok-4.6' })
    return t
  }
  const messages: ChatMessage[] = [{ role: 'user', content: 'hello' }]
  const drive = async (
    t: InstanceType<typeof Thalamus>,
    signal?: AbortSignal
  ): Promise<{ kinds: string[]; failures: Array<{ errorReason: string }>; text: string }> => {
    const kinds: string[] = []
    let failures: Array<{ errorReason: string }> = []
    let text = ''
    for await (const chunk of t.stream({ system: '', messages, tools: [], signal })) {
      kinds.push(chunk.type)
      if (chunk.type === 'text') text += chunk.text
      if (chunk.type === 'no_provider_available') failures = chunk.failures
      if (chunk.type === 'error' && chunk.failures) failures = chunk.failures
    }
    return { kinds, failures, text }
  }

  await check(
    'a stream with no chunk for the window ends the turn as stalled, without a retry',
    async () => {
      const fake = new FakeProvider('silent')
      const started = Date.now()
      const r = await drive(make(fake, 150))
      assert.ok(Date.now() - started < 2_000, 'must not sit through the retry ladder')
      assert.equal(fake.calls, 1, 'no retry on a stall')
      assert.ok(r.kinds.includes('no_provider_available'), r.kinds.join(','))
      assert.equal(r.failures[0]?.errorReason, STREAM_STALL_REASON)
    }
  )

  await check(
    'a slow but alive stream is never cut: the timer re-arms on every chunk',
    async () => {
      const fake = new FakeProvider('slow')
      // Window shorter than the whole reply, longer than any single gap.
      const r = await drive(make(fake, 120))
      assert.equal(r.text, 't0 t1 t2 t3 ')
      assert.ok(!r.kinds.includes('no_provider_available'), r.kinds.join(','))
      assert.equal(fake.calls, 1)
    }
  )

  await check('silence after some text is still a stall, not a committed answer', async () => {
    const fake = new FakeProvider('silent-after-text')
    const r = await drive(make(fake, 150))
    assert.equal(r.text, 'partial ')
    assert.equal(r.failures[0]?.errorReason, STREAM_STALL_REASON)
    assert.equal(fake.calls, 1)
  })

  await check("the user's own Stop is reported as a cancel, not a stall", async () => {
    const fake = new FakeProvider('silent')
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('user stop')), 50)
    const r = await drive(make(fake, 10_000), controller.signal)
    assert.ok(!r.failures.some((f) => f.errorReason === STREAM_STALL_REASON), 'not stalled')
  })

  await check('the default window is five minutes and the local model is exempt', async () => {
    const { STREAM_STALL_MS } = await import('../thalamus')
    assert.equal(STREAM_STALL_MS, 5 * 60_000)
    const src = (await import('node:fs')).readFileSync(
      new URL('../thalamus.ts', import.meta.url),
      'utf8'
    )
    assert.ok(/entry\.id === 'local' \? 0 : this\.stallTimeoutMs/.test(src), 'local exempt')
  })

  console.log(`\n${n} checks run`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
