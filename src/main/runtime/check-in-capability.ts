import type { Cerebellum, WolffishPlugin } from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'
import {
  CHECK_IN_ARG,
  DEFAULT_CHECK_IN_SECONDS,
  formatElapsed,
  type CheckInManager
} from '@main/runtime/check-in'

/**
 * The `check-in` capability — the model-facing half of runtime/check-in.ts.
 *
 * Two tools over a parked call's handle: `call_wait` blocks on it again and
 * returns its real result, `call_stop` ends it. Core and locked: the moment
 * a check-in lands, both must be one call away.
 */

export const CALL_WAIT_TOOL = 'call_wait'
export const CALL_STOP_TOOL = 'call_stop'

function conversationKey(): string | null {
  const scope = turnScope.getStore()
  if (!scope) return null
  return scope.conversationId ?? scope.turnId ?? null
}

export function registerCheckInCapability(cerebellum: Cerebellum, checkIns: CheckInManager): void {
  const plugin: WolffishPlugin = {
    name: 'check-in',
    tools: [],
    execute: async (toolName, args, signal) => {
      const handle = typeof args?.handle === 'string' ? args.handle.trim() : ''
      if (!handle) {
        return {
          success: false,
          retryable: false,
          error: 'handle is required — the `call-N` handle a check-in gave you.'
        }
      }
      const key = conversationKey()
      if (!key) {
        return { success: false, retryable: false, error: 'Only callable from inside a turn.' }
      }
      if (toolName === CALL_STOP_TOOL) {
        const res = checkIns.stop(handle, key)
        if (!res.ok) return { success: false, retryable: false, error: res.error }
        return {
          success: true,
          output: `Stopped ${handle} (\`${res.record.name}\`${res.record.argsSummary ? ` ${res.record.argsSummary}` : ''}) after ${formatElapsed(Date.now() - res.record.startedAt)}. Take the narrower route now; call_wait handle="${handle}" returns whatever it printed before the stop if you need it.`,
          meta: { checkIn: { handle, state: 'stopped' } }
        }
      }
      if (toolName === CALL_WAIT_TOOL) {
        const raw = args?.[CHECK_IN_ARG]
        const n = typeof raw === 'string' ? Number(raw) : raw
        const seconds =
          typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : DEFAULT_CHECK_IN_SECONDS
        const outcome = await checkIns.wait(handle, key, seconds, signal)
        if (outcome.kind === 'unknown') {
          return {
            success: false,
            retryable: false,
            error: `No checked-in call with handle "${handle}" in this conversation (it may already have been read).`
          }
        }
        if (outcome.kind === 'checked_in') {
          return {
            success: true,
            output: outcome.text,
            meta: { checkIn: { handle, state: 'running' } }
          }
        }
        const { record, result } = outcome
        const elapsed = formatElapsed((record.finishedAt ?? Date.now()) - record.startedAt)
        const head =
          record.state === 'stopped'
            ? `${handle} (\`${record.name}\`) was stopped after ${elapsed}. Its output up to the stop:`
            : `${handle} (\`${record.name}\`) finished after ${elapsed}${result.ok ? '' : ' with an error'}. Its result:`
        const meta = {
          ...(result.meta ?? {}),
          checkIn: { handle, state: record.state === 'stopped' ? 'stopped' : 'finished' },
          ...(record.stoppedBy ? { stoppedBy: record.stoppedBy } : {})
        }
        if (result.ok) {
          return {
            success: true,
            output: `${head}\n\n${result.output}`,
            images: result.images,
            meta
          }
        }
        return {
          success: false,
          retryable: false,
          error: `${head}\n\n${result.output}`,
          output: result.verbose ?? result.output,
          meta
        }
      }
      return { success: false, retryable: false, error: `check-in: unknown tool ${toolName}` }
    }
  }

  cerebellum.registerInProcessCapability(
    {
      name: 'check-in',
      dir: '',
      description:
        'Act on a tool call that checked in as still running: block on it again for its real result, or stop it.',
      triggers: { keywords: ['still running', 'check in', 'long command', 'taking too long'] },
      tools: [
        {
          name: CALL_WAIT_TOOL,
          readOnly: true,
          description: [
            'Block on a checked-in call (a tool call that reported STILL RUNNING and gave you a `call-N` handle) and return its real result the moment it lands.',
            '',
            `If it is still running when this call's own check-in comes (${CHECK_IN_ARG}, default ${DEFAULT_CHECK_IN_SECONDS}s), you get another STILL RUNNING report with the latest progress and decide again. Waiting as many times as the job needs is fine — a build or a large download can take an hour — as long as each wait is a decision you made after reading the progress.`,
            '',
            'Also the way to read the result of a call that already finished while you were doing other work (the runtime status names those).'
          ].join('\n'),
          parameters: {
            handle: {
              type: 'string',
              description:
                'The `call-N` handle from the STILL RUNNING report or the runtime status.'
            },
            [CHECK_IN_ARG]: {
              type: 'number',
              required: false,
              description: `Seconds to block before the next check-in. Default ${DEFAULT_CHECK_IN_SECONDS}. Set it to what this job should reasonably need — longer for a build you can see progressing, shorter when you expect it to end any moment.`
            }
          }
        },
        {
          name: CALL_STOP_TOOL,
          description: [
            'Stop a checked-in call. For a shell command this kills the whole process tree; for any other tool it aborts the call.',
            '',
            'Use it when the STILL RUNNING report shows the wrong call — a search crawling far more than it should, a command hung or waiting for input, work that a narrower or different route does in seconds. Then take that route. Its partial output stays readable through call_wait.'
          ].join('\n'),
          parameters: {
            handle: {
              type: 'string',
              description:
                'The `call-N` handle from the STILL RUNNING report or the runtime status.'
            }
          }
        }
      ],
      body: '',
      hasPlugin: true,
      status: 'ok',
      requires: [],
      packages: {},
      npmDependencies: {}
    },
    plugin
  )
}
