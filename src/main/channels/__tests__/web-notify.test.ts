/**
 * notify_web — the Web UI twin of notify_phone: what the tool validates,
 * where a tap lands, how a delivery reads back to the model, and the
 * UNCONFIRMED wording the agent's once-per-turn guard keys on.
 *
 * Standalone — no vitest/jest in this repo. Run:
 *   npx tsx --tsconfig tsconfig.node.json src/main/channels/__tests__/web-notify.test.ts
 */
import Module from 'node:module'
import os from 'node:os'
import type { NotifyInput, NotifyResult } from '@main/channels/web/server'

// Shim `electron` so the import graph loads outside an Electron process.
const loader = Module as unknown as { _load: (...a: unknown[]) => unknown }
const origLoad = loader._load
loader._load = function (this: unknown, ...args: unknown[]): unknown {
  if (args[0] === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => os.tmpdir(),
        getVersion: () => '0.0.0'
      },
      ipcMain: { handle: () => undefined, on: () => undefined }
    }
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

type Result = { success: boolean; output?: string; error?: string; retryable?: boolean }

async function run(): Promise<void> {
  const { buildWebCapability, WEB_CAPABILITY_NAME } = await import('@main/channels/web/notify')
  const { turnScope } = await import('@main/runtime/corpus')
  const { TURN_CLOSING_TOOLS } = await import('@main/runtime/agent/closing-guard')

  const calls: NotifyInput[] = []
  let next: NotifyResult = { id: 'n1', inband: 1, pushed: 1, gone: 0, failed: 0, errors: [] }
  let boom: Error | null = null
  const { capability, plugin } = buildWebCapability({
    notify: async (input) => {
      if (boom) throw boom
      calls.push(input)
      return next
    }
  })
  const tool = capability.tools[0]

  ok(
    'capability is web-ui, in-process',
    capability.name === WEB_CAPABILITY_NAME &&
      capability.name === 'web-ui' &&
      capability.hasPlugin === true
  )
  ok(
    'one read-only tool, notify_web',
    capability.tools.length === 1 && tool.name === 'notify_web' && tool.readOnly === true
  )
  ok(
    'plugin exposes the same tool with title and body required',
    plugin.tools.length === 1 &&
      plugin.tools[0].name === 'notify_web' &&
      (plugin.tools[0].parameters as { required: string[] }).required.join(',') === 'title,body'
  )
  ok('notify_web closes a turn like notify_phone', TURN_CLOSING_TOOLS.has('notify_web'))
  ok(
    'description carries the cadence and the no-repeat rule',
    /END EVERY TURN WITH ONE CALL/.test(tool.description) &&
      /NEVER THE SAME NEWS TWICE/.test(tool.description)
  )

  const exec = (args: Record<string, unknown>): Promise<Result> =>
    turnScope.run(
      { turnId: 't1', conversationId: 'conv_1', autonomous: false },
      () => plugin.execute('notify_web', args) as unknown as Promise<Result>
    )

  // ── validation ────────────────────────────────────────────────────────────
  const noTitle = await exec({ body: 'x' })
  ok(
    'title required, not retryable',
    noTitle.success === false && /title/.test(noTitle.error ?? '') && noTitle.retryable === false,
    JSON.stringify(noTitle)
  )
  const noBody = await exec({ title: 'T' })
  ok('body required', noBody.success === false && /body/.test(noBody.error ?? ''))
  ok('nothing sent for an invalid call', calls.length === 0)

  // ── where a tap lands ────────────────────────────────────────────────────
  const r1 = await exec({ title: 'Done', body: 'All good' })
  ok(
    "default open=current lands on the run's own conversation",
    r1.success === true &&
      calls[0].url === '/?conversation=conv_1' &&
      calls[0].conversationId === 'conv_1',
    JSON.stringify(calls[0])
  )
  ok(
    'phase and urgency default to info/normal',
    calls[0].phase === 'info' && calls[0].urgency === 'normal'
  )
  await exec({ title: 'T', body: 'B', open: 'none', phase: 'completed', urgency: 'high' })
  ok(
    'open=none opens the app; phase and urgency pass through',
    calls[1].url === '/' &&
      calls[1].phase === 'completed' &&
      calls[1].urgency === 'high' &&
      calls[1].conversationId === 'conv_1',
    JSON.stringify(calls[1])
  )
  await exec({ title: 'T', body: 'B', open: 'conv_other' })
  ok(
    'open=<id> targets that conversation',
    calls[2].url === '/?conversation=conv_other' && calls[2].conversationId === 'conv_other'
  )
  const badOpen = await exec({ title: 'T', body: 'B', open: 'javascript:alert(1)' })
  ok(
    'a bad open is refused and nothing is sent',
    badOpen.success === false && /open must be/.test(badOpen.error ?? '') && calls.length === 3,
    JSON.stringify(badOpen)
  )
  await exec({ title: 'A\u0000B   C' + 'x'.repeat(200), body: 'line1\nline2\u0007' })
  ok(
    'title is cleaned and capped at 80; the body keeps its newline',
    calls[3].title.length === 80 &&
      !calls[3].title.includes('\u0000') &&
      calls[3].title.startsWith('A B C') &&
      calls[3].body === 'line1\nline2',
    JSON.stringify({ title: calls[3].title, body: calls[3].body })
  )
  const outside = (await plugin.execute('notify_web', {
    title: 'T',
    body: 'B'
  })) as unknown as Result
  ok(
    'outside a turn, open=current falls back to the app root',
    outside.success === true && calls[4].url === '/' && calls[4].conversationId === null
  )
  const odd = await exec({ title: 'T', body: 'B', phase: 'nope', urgency: 'loud' })
  ok(
    'unknown phase/urgency fall back instead of failing',
    odd.success === true && calls[5].phase === 'info' && calls[5].urgency === 'normal'
  )

  // ── what the model reads back ────────────────────────────────────────────
  ok(
    'delivery report names both paths and the id',
    r1.success === true &&
      /shown in 1 open browser/.test(r1.output ?? '') &&
      /pushed to 1 subscribed browser/.test(r1.output ?? '') &&
      /notificationId n1/.test(r1.output ?? ''),
    r1.output
  )
  next = { id: 'n2', inband: 0, pushed: 0, gone: 0, failed: 0, errors: [] }
  const nobody = await exec({ title: 'T', body: 'B' })
  ok(
    'nobody to reach → a failure that forbids a retry',
    nobody.success === false &&
      /no browser to reach/.test(nobody.error ?? '') &&
      /do not retry/.test(nobody.error ?? '') &&
      nobody.retryable === false,
    JSON.stringify(nobody)
  )
  next = { id: 'n3', inband: 0, pushed: 0, gone: 1, failed: 1, errors: ['503 from push service'] }
  const unconfirmed = await exec({ title: 'T', body: 'B' })
  ok(
    "push failures → UNCONFIRMED, the word the agent's once-per-turn guard keys on",
    unconfirmed.success === false &&
      /UNCONFIRMED/.test(unconfirmed.error ?? '') &&
      /1 stale subscription dropped/.test(unconfirmed.error ?? '') &&
      /503 from push service/.test(unconfirmed.error ?? '') &&
      unconfirmed.retryable === false,
    JSON.stringify(unconfirmed)
  )
  next = { id: 'n4', inband: 2, pushed: 0, gone: 1, failed: 0, errors: [] }
  const partial = await exec({ title: 'T', body: 'B' })
  ok(
    'a partial delivery still succeeds and reports the dropped subscription',
    partial.success === true &&
      /shown in 2 open browsers/.test(partial.output ?? '') &&
      /1 stale subscription dropped/.test(partial.output ?? ''),
    partial.output
  )
  boom = new Error('push keys missing')
  const thrown = await exec({ title: 'T', body: 'B' })
  ok(
    'a thrown delivery surfaces as a non-retryable failure',
    thrown.success === false && thrown.error === 'push keys missing' && thrown.retryable === false
  )
  boom = null
  const unknown = (await plugin.execute('nope', {})) as unknown as Result
  ok('unknown tool refused', unknown.success === false)

  console.log(`web-notify: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
