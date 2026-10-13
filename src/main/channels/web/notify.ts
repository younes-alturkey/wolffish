/**
 * The model's way to reach a browser: `notify_web`, the Web UI's twin of the
 * phone's `notify_phone`. Same contract — the model chooses the words and
 * the moment; the harness owns identity, routing and the fact that one call
 * is one delivery and never a retry.
 *
 * Delivery is server.ts's `notify`: an in-band frame to every connected
 * browser (a toast, and a system notification when the page is hidden and
 * no push subscription covers it) plus an encrypted Web Push to every
 * subscription on file, which is what lands on a locked phone with the
 * browser closed. Registered with the cerebellum only while the channel is
 * listening, notifications are on, and at least one browser has signed in —
 * the tool's presence is itself the statement "there is someone to reach".
 */
import type { NotifyInput, NotifyResult } from '@main/channels/web/server'
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'

export const WEB_CAPABILITY_NAME = 'web-ui'

const PHASES = ['completed', 'failed', 'needs_input', 'started', 'info'] as const
const URGENCIES = ['normal', 'high'] as const
const TITLE_MAX = 80

type Phase = (typeof PHASES)[number]
type Urgency = (typeof URGENCIES)[number]

function sanitizeTitle(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, TITLE_MAX)
  )
}

function sanitizeBody(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x09\x0b-\x1f\x7f]+/g, ' ')
      .trim()
  )
}

function success(output: string): ToolExecutionResult {
  return { success: true, output }
}

/** Non-retryable on purpose — see notify_phone: a second send is a second banner. */
function failure(error: string): ToolExecutionResult {
  return { success: false, error, retryable: false }
}

type ToolDeps = {
  notify: (input: NotifyInput) => Promise<NotifyResult>
}

export function buildWebCapability(deps: ToolDeps): {
  capability: Capability
  plugin: WolffishPlugin
} {
  const tools: SkillToolDescriptor[] = [
    {
      name: 'notify_web',
      readOnly: true,
      description: `Send a browser notification to the user's signed-in Web UI browsers — their phone's lock screen when they added Wolffish to the home screen, their desktop's notification center otherwise. It is delivered as a Web Push, so it lands even with the tab closed, and a browser that is open also gets it as a toast in the app. This tool being available already means a browser has signed in and notifications are allowed. NOTIFYING IS THE DEFAULT — silence is what needs a reason. END EVERY TURN WITH ONE CALL, as the LAST tool of your wrap-up: after the work is done and any files are delivered — phase 'completed' (or 'failed'), open 'current'. A turn the user watched you finish still gets one; they will be somewhere else five minutes from now. THIS TOOL NEVER EARNS A SECOND REPLY: your wrap-up is written BEFORE it, and once it lands the turn is over — do not restate what you just wrote. Send one MID-turn too, the moment something major happens: you are blocked on their input or approval ('needs_input' — the moment you block), a step fails in a way that changes the plan, or you turn up a finding they would act on now. Long work also earns a 'started'. The BODY must carry real information — the outcome, the number, what is next: 'Sheet rebuilt — 214 rows, 3 broken dates fixed' earns the buzz; 'Done' wastes it. Stay silent only when there is genuinely nothing to carry (small talk, a one-line acknowledgment), for mid-turn narration, or when the user has asked for quiet. NEVER THE SAME NEWS TWICE — nothing here counts your notifications or refuses a repeat, so every call reaches the user: one call per moment, never a reworded repeat, and never a retry loop.`,
      parameters: {
        title: {
          type: 'string',
          description: `Short headline, at most ${TITLE_MAX} characters, one line — e.g. "Migration finished".`,
          required: true
        },
        body: {
          type: 'string',
          description:
            'What happened and what (if anything) the user should do — e.g. "All 214 rows converted cleanly. Nothing needs your attention." The banner shows as much as fits; write what is worth reading.',
          required: true
        },
        phase: {
          type: 'string',
          enum: [...PHASES],
          description:
            '"completed" / "failed" for terminal outcomes — the turn-closing notification is one of these — "needs_input" when you are blocked on the user, "started" when long work is now underway, "info" (default) for a mid-turn finding worth knowing now.',
          required: false
        },
        urgency: {
          type: 'string',
          enum: [...URGENCIES],
          description:
            '"high" only when the user is actively waiting or something needs them now; otherwise omit.',
          required: false
        },
        open: {
          type: 'string',
          description:
            'Where a tap on the notification lands: "current" (default) opens this run\'s own conversation, a conversation id from conversation_list opens that one, "none" just opens the app. Always prefer "current" to spelling an id out.',
          required: false
        }
      }
    }
  ]

  const capability: Capability = {
    name: WEB_CAPABILITY_NAME,
    dir: '<in-process>',
    description: `Reach the user's signed-in browsers (the Web UI). notify_web sends a browser notification that lands even with the tab closed — on a phone that keeps Wolffish on its home screen, on the lock screen — and shows as a toast inside any open Web UI. Notifying is the DEFAULT, not an exception: every turn ends with one carrying the actual outcome, and a major mid-turn beat gets one the moment it happens. Nothing rate-limits it: call it once per moment — never the same news twice, and never a retry loop. This capability is only present while a browser has signed in and notifications are allowed.`,
    triggers: {
      keywords: ['notify', 'browser', 'web', 'push notification', 'ping me', 'alert me']
    },
    tools,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }

  const plugin: WolffishPlugin = {
    name: WEB_CAPABILITY_NAME,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters)
    })),
    execute: async (toolName, args) => {
      if (toolName !== 'notify_web') return failure(`unknown web tool: ${toolName}`)
      return notifyWeb(deps, args)
    }
  }

  return { capability, plugin }
}

async function notifyWeb(
  deps: ToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const title = sanitizeTitle(typeof args.title === 'string' ? args.title : '')
  if (!title) return failure('invalid argument: title is required (a short, plain-text headline)')
  const body = sanitizeBody(typeof args.body === 'string' ? args.body : '')
  if (!body) return failure('invalid argument: body is required (plain text)')
  const phase: Phase = PHASES.includes(args.phase as Phase) ? (args.phase as Phase) : 'info'
  const urgency: Urgency = URGENCIES.includes(args.urgency as Urgency)
    ? (args.urgency as Urgency)
    : 'normal'

  const scope = turnScope.getStore()
  const conversationId = scope?.conversationId ?? null
  const open = typeof args.open === 'string' && args.open.trim() ? args.open.trim() : 'current'
  let url: string | null = '/'
  let target: string | null = null
  if (open === 'none') url = '/'
  else if (open === 'current') {
    target = conversationId
    url = conversationId ? `/?conversation=${encodeURIComponent(conversationId)}` : '/'
  } else if (/^[A-Za-z0-9_.-]{1,128}$/.test(open)) {
    target = open
    url = `/?conversation=${encodeURIComponent(open)}`
  } else {
    return failure(
      `invalid argument: open must be "current", "none" or a conversation id — got ${open.slice(0, 60)}. Nothing was sent.`
    )
  }

  let result: NotifyResult
  try {
    result = await deps.notify({
      title,
      body,
      phase,
      urgency,
      url,
      conversationId: target ?? conversationId
    })
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error))
  }
  const reached = result.inband + result.pushed
  if (reached === 0 && result.gone === 0 && result.failed === 0) {
    return failure(
      'no browser to reach: nobody is connected to the Web UI right now and no browser has allowed push notifications. The user will see nothing — do not retry; say it in your reply instead.'
    )
  }
  const parts: string[] = []
  if (result.inband > 0)
    parts.push(`shown in ${result.inband} open browser${result.inband === 1 ? '' : 's'}`)
  if (result.pushed > 0)
    parts.push(`pushed to ${result.pushed} subscribed browser${result.pushed === 1 ? '' : 's'}`)
  if (result.gone > 0)
    parts.push(`${result.gone} stale subscription${result.gone === 1 ? '' : 's'} dropped`)
  if (result.failed > 0)
    parts.push(
      `${result.failed} push${result.failed === 1 ? '' : 'es'} failed (${result.errors[0] ?? 'unknown'})`
    )
  if (reached === 0) {
    return failure(
      `the notification's delivery is UNCONFIRMED: ${parts.join('; ')}. Sending it again risks a duplicate — do not retry.`
    )
  }
  return success(`Delivered — ${parts.join('; ')}. notificationId ${result.id}.`)
}

function toJsonSchema(parameters: SkillToolDescriptor['parameters']): {
  type: 'object'
  properties: Record<string, { type: string; description: string; enum?: string[] }>
  required: string[]
} {
  const properties: Record<string, { type: string; description: string; enum?: string[] }> = {}
  const required: string[] = []
  for (const [name, spec] of Object.entries(parameters)) {
    properties[name] = {
      type: spec.type ?? 'string',
      description: spec.description ?? '',
      ...(spec.enum ? { enum: spec.enum } : {})
    }
    if (spec.required) required.push(name)
  }
  return { type: 'object', properties, required }
}
