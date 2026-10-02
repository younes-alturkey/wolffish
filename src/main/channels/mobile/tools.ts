import {
  NOTIFY_PHASES,
  NOTIFY_TITLE_MAX,
  NOTIFY_URGENCIES,
  DEEPLINK_ROUTES,
  DEEPLINK_SCHEME,
  buildDeeplink,
  isAllowedDeeplink,
  parseDeeplink,
  type NotifyPhase,
  type NotifyResultFrame,
  type NotifyUrgency
} from '@main/tunnel/protocol'
import type {
  Capability,
  SkillToolDescriptor,
  ToolExecutionResult,
  WolffishPlugin
} from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'
import { randomBytes } from 'node:crypto'

/**
 * Capability name used to register the phone-notification tool with the
 * cerebellum. Lives outside brain/cerebellum/ — it's an in-process capability
 * the mobile channel manages directly, exactly like the Telegram channel's.
 */
export const MOBILE_CAPABILITY_NAME = 'phone'

/**
 * Notifications are 100% model-led. This tool is the ONLY way a phone
 * notification comes into being, and the decision to send one is the model's
 * alone: nothing here counts them, caps them per run or per phase, or refuses
 * a repeat of something already sent. Every call reaches the phone.
 *
 * The harness's job is the two things the model cannot do for itself:
 *
 *   ROUTE   the phone's identity, the notification id and the ttl are stamped
 *           in the channel and never taken from the model, so a notification
 *           cannot be misaddressed and a deeplink cannot name a screen the app
 *           does not have. Model input is untrusted — lengths clamp, enums
 *           fall back, an undeliverable link is refused with the real list.
 *   REPORT  what actually happened, including when that is "unknown". A
 *           delivery the relay never confirmed is said to be UNCONFIRMED
 *           rather than failed, because the two call for different judgements
 *           and only the model gets to make them.
 *
 * The one hard rule points at the harness, not the model: one call, one frame.
 * Every failure returned here is `retryable: false`, so motor cannot re-fire a
 * send on its own — which it did, three times, on 2026-08-08.
 */

/** ttl per phase — harness policy, deliberately not a model input. A stale
 *  approval prompt arriving 40 minutes late is worse than no prompt at all,
 *  so needs_input expires fast; terminal states may wait for the user. */
export const TTL_BY_PHASE: Record<NotifyPhase, number> = {
  needs_input: 300,
  failed: 3600,
  completed: 3600,
  started: 900,
  info: 900
}

/**
 * The one conversation id the model never has to look up: the run's own.
 *
 * A foreground turn does not otherwise know the id of the conversation it is
 * answering in, and a background run's conversation is minted after the model
 * was prompted — so asking the model to spell one out is asking it to guess,
 * and a guessed id opens someone else's transcript on the user's phone. The
 * harness substitutes it from the turn scope instead: the same place runId
 * comes from, and equally not the model's to choose.
 */
const CURRENT_CONVERSATION = 'current'

/** The settings pages, named as a deeplink spells them. Derived from the route
 *  table so what the model is told can never drift from what is accepted. */
const SETTINGS_PAGES = DEEPLINK_ROUTES.filter((route) => route.startsWith('settings/'))
  .map((route) => route.slice('settings/'.length))
  .join(', ')

/** Every destination, spelled out — the refusal that teaches. */
const EVERY_TARGET = DEEPLINK_ROUTES.map((route) => `${DEEPLINK_SCHEME}${route}`).join(', ')

export type NotifyPhoneRequest = {
  title: string
  body: string
  phase: NotifyPhase
  urgency: NotifyUrgency
  deeplink: string | null
  /**
   * The conversation this notification came out of, from the turn scope —
   * harness identity, exactly like runId, and never the model's to choose.
   * Null only for a run that has no conversation of its own yet.
   */
  conversationId: string | null
  runId: string
}

type ToolDeps = {
  /**
   * Stamp identity (phoneId from the pairing record, a fresh ULID), emit the
   * notify frame over the existing relay connection, and answer with the
   * relay's routing decision. Throws with a user-readable message when the
   * setting is off, no phone is paired, or the relay link is down.
   */
  notify: (request: NotifyPhoneRequest) => Promise<NotifyResultFrame>
}

/** Crockford base32 alphabet, as ULID specifies (no I, L, O, U). */
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * A spec-shaped ULID: 48-bit timestamp + 80 random bits, Crockford base32.
 * Generated HERE, on the desktop — the model never chooses notification ids,
 * which is what makes the relay's idempotency by id trustworthy.
 */
export function mintNotificationId(now = Date.now()): string {
  let time = ''
  let ms = now
  for (let i = 0; i < 10; i += 1) {
    time = ULID_ALPHABET[ms % 32] + time
    ms = Math.floor(ms / 32)
  }
  const random = randomBytes(16)
  let entropy = ''
  for (let i = 0; i < 16; i += 1) entropy += ULID_ALPHABET[random[i] % 32]
  return time + entropy
}

/** One line, printable: control characters and newlines cannot reach a
 *  notification banner. */
function sanitizeTitle(raw: string): string {
  return (
    raw
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NOTIFY_TITLE_MAX)
  )
}

/** Bodies may wrap, but carry no other control characters. Deliberately
 *  unclamped: the phone renders the body whole on its notifications page, so a
 *  ceiling here would cut text the user could then read nowhere at all. */
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

/**
 * Every failure this tool can return is non-retryable, and that is a property
 * of the TOOL, not of any particular message.
 *
 * Half of them are deterministic (a bad deeplink, a disabled setting, a spent
 * budget) and would fail identically. The other half — anything from the
 * delivery layer — is worse than deterministic: it is UNKNOWN. A notification
 * the relay never answered for may well be on the user's lock screen already,
 * so "failed" here never licenses a second send.
 *
 * Motor honours this flag before its own text heuristics. Without it the
 * generic retry loop re-fired a "the relay did not answer" notify twice, 2 s
 * and 4 s later, each with a fresh notificationId that neither the relay's
 * idempotency record nor the phone's seen-set could fold — three identical
 * notifications from one model call, and only the last one in the transcript.
 */
function failure(error: string): ToolExecutionResult {
  return { success: false, error, retryable: false }
}

/**
 * Build the phone capability + plugin pair to register with the cerebellum
 * while the mobile channel runs. One tool, a deliberately minimal surface:
 * the model chooses words and importance; the harness owns identity, routing,
 * ttl and rate.
 */
export function buildMobileCapability(deps: ToolDeps): {
  capability: Capability
  plugin: WolffishPlugin
} {
  const tools: SkillToolDescriptor[] = [
    {
      name: 'notify_phone',
      // A push complements the reply and changes nothing the user is
      // working on, so a read-only turn (plan mode) may still close with one.
      readOnly: true,
      description: `Send a push notification to the user's paired phone — their lock screen, their pocket. It lands even when the mobile app is closed or backgrounded, and when the phone is offline it arrives as soon as signal returns (iOS and Android alike), so this reaches the user when nothing else does. This tool being available already means a phone is paired and notifications are allowed. NOTIFYING IS THE DEFAULT — silence is what needs a reason. END EVERY TURN WITH ONE CALL, as the LAST tool of your wrap-up: after the work is done and any files are delivered — phase 'completed' (or 'failed'), deeplink "${DEEPLINK_SCHEME}chat?id=${CURRENT_CONVERSATION}". A turn the user watched you finish still gets one; they will be somewhere else five minutes from now, and the phone is a second surface, not a mirror of the screen they happen to be at. THIS TOOL NEVER EARNS A SECOND REPLY: your wrap-up is written BEFORE it, and once it lands the turn is over — do not restate, summarise or reword what you just wrote. If you find yourself composing prose after it, you have already said that news: end that reply with zero characters. A second closing paragraph is the same news twice on the user's screen. Send one MID-turn too, without waiting for the end, the moment something major happens: you are blocked on their input or approval ('needs_input' — the moment you block; it expires in minutes), a step fails in a way that changes the plan, or you turn up a finding they would act on now rather than in ten minutes. Long work (a big build, scrape, render, video, multi-step automation) also earns a 'started' so they know it is underway, and a scheduled automation always closes its digest with one 'completed'. The BODY must carry real information — the outcome, the number, what is next: 'AI news is ready — 7 stories, 2 worth your time' or 'Sheet rebuilt — 214 rows, 3 broken dates fixed' earn the buzz; 'Task completed' and 'Done' waste it. Stay silent only when there is genuinely nothing to carry (small talk, a one-line acknowledgment, an answer the notification would repeat word for word), for mid-turn narration ('opened the file', 'tests running' — prose does that job), on Telegram/WhatsApp turns where your reply already reached that same phone as a message with its own notification (there, notify only for the blocker/failure/major-finding cases), or when the user has asked for quiet. A notification COMPLEMENTS your conversation reply, never replaces any part of it: it is not shown in the conversation, so the reply must stand complete on its own and never lean on the notification. NEVER THE SAME NEWS TWICE — nothing here counts your notifications or refuses a repeat, so every call lands on the user's phone: one call per moment, never a reworded repeat, and never a retry loop. An answer reporting delivery as UNCONFIRMED means it may already be on their lock screen, so sending it again — reworded, re-phased, or verbatim — is how one notification becomes three in someone's pocket.`,
      parameters: {
        title: {
          type: 'string',
          description: `Short headline shown on the phone's lock screen. At most ${NOTIFY_TITLE_MAX} characters, one line — e.g. "Migration finished".`,
          required: true
        },
        body: {
          type: 'string',
          description: `The notification body. Say what happened and what (if anything) the user should do — e.g. "All 214 rows converted cleanly. Nothing needs your attention." The lock-screen banner shows only as much as fits, but the phone keeps the whole body on its notifications page, so write what is worth reading rather than trimming to a banner.`,
          required: true
        },
        phase: {
          type: 'string',
          enum: [...NOTIFY_PHASES],
          description:
            'What moment of the run this announces: "completed" / "failed" for terminal outcomes — the turn-closing notification is one of these — "needs_input" when you are blocked on the user, "started" when long work is now underway, "info" (default) for a mid-turn finding worth knowing now.',
          required: false
        },
        urgency: {
          type: 'string',
          enum: [...NOTIFY_URGENCIES],
          description:
            'Delivery priority on the phone. "high" only when the user is actively waiting or something needs them now; otherwise omit for "normal".',
          required: false
        },
        deeplink: {
          type: 'string',
          description: `Which screen of the mobile app the tap opens. Omitted, a tap just opens the app wherever the user left it — nothing navigates that you did not choose, so pass this whenever the notification is ABOUT something they can look at. Conversations: ${DEEPLINK_SCHEME}chat?id=${CURRENT_CONVERSATION} opens this run's own conversation and is the one you want almost every time — always prefer it to spelling an id out, since you do not reliably know your own conversation id; ${DEEPLINK_SCHEME}chat?id=<conversationId> opens a DIFFERENT conversation by its exact id from conversation_list; ${DEEPLINK_SCHEME}chat with no id opens a new empty chat; ${DEEPLINK_SCHEME}history is the list of all conversations. App screens: ${DEEPLINK_SCHEME}settings, or ${DEEPLINK_SCHEME}settings/<page> where <page> is exactly one of ${SETTINGS_PAGES} — e.g. ${DEEPLINK_SCHEME}settings/automations for a scheduled run's own schedule, ${DEEPLINK_SCHEME}settings/usage for spend, ${DEEPLINK_SCHEME}settings/services for a provider key that needs attention. Nothing else exists: another scheme, a page not in that list, or an invented path is refused with the full list of what does — nothing was sent, so fix the link and call once more.`,
          required: false
        }
      }
    }
  ]

  const capability: Capability = {
    name: MOBILE_CAPABILITY_NAME,
    dir: '<in-process>',
    description: `Reach the user's paired phone. notify_phone sends a push notification that lands even on a closed, backgrounded, or offline app (iOS and Android), so it reaches the user when nothing else does. Notifying is the DEFAULT, not an exception: every turn ends with one carrying the actual outcome, and a major mid-turn beat — blocked on the user, a failure that changes the plan, a finding worth acting on now — gets one the moment it happens. The tap itself navigates wherever the model says: deeplink "${DEEPLINK_SCHEME}chat?id=${CURRENT_CONVERSATION}" opens the run's own conversation, and every other screen the app has — history, settings and each settings page — can be named the same way; without a deeplink a tap just opens the app. Nothing rate-limits it: every call reaches the user's phone, so call it once per moment — never the same news twice, and never a retry loop. This capability is only present while a phone is paired and notifications are allowed.`,
    triggers: { keywords: ['notify', 'phone', 'push notification', 'ping me', 'alert me'] },
    tools,
    body: '',
    hasPlugin: true,
    status: 'ok',
    requires: [],
    packages: {},
    npmDependencies: {}
  }

  const plugin: WolffishPlugin = {
    name: MOBILE_CAPABILITY_NAME,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toJsonSchema(t.parameters)
    })),
    execute: async (toolName, args) => {
      if (toolName !== 'notify_phone') return failure(`unknown phone tool: ${toolName}`)
      return notifyPhone(deps, args)
    }
  }

  return { capability, plugin }
}

async function notifyPhone(
  deps: ToolDeps,
  args: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const title = sanitizeTitle(typeof args.title === 'string' ? args.title : '')
  if (!title) return failure('invalid argument: title is required (a short, plain-text headline)')
  const body = sanitizeBody(typeof args.body === 'string' ? args.body : '')
  if (!body) return failure('invalid argument: body is required (plain text, up to 180 characters)')

  const phase: NotifyPhase = NOTIFY_PHASES.includes(args.phase as NotifyPhase)
    ? (args.phase as NotifyPhase)
    : 'info'
  const urgency: NotifyUrgency = NOTIFY_URGENCIES.includes(args.urgency as NotifyUrgency)
    ? (args.urgency as NotifyUrgency)
    : 'normal'

  // The run identity comes from the harness's own async context — never from
  // the model — and it is what the relay's audit trail keys on. Turns and
  // background automations both carry one.
  const scope = turnScope.getStore()
  const runId = scope?.turnId ?? 'untracked'
  /**
   * The conversation this notification comes OUT of — sent on every frame,
   * whatever the model asked for as a destination.
   *
   * These are two different questions and the phone needs both. `deeplink` is
   * where a TAP goes, and it is the model's call right down to omitting it.
   * This is which conversation raised the notification, and it is what the
   * phone puts a badge on. Inferring the second from the first is what made a
   * conversation that had sent five notifications wear a 2: the ones the model
   * sent without a deeplink — which this tool deliberately permits — named no
   * conversation at all, so the phone had nothing to count them against.
   */
  const conversationId = scope?.conversationId ?? null

  // WHERE a tap lands stays 100% the model's choice — no deeplink still means
  // a tap simply opens the app, and nothing here invents a destination. What
  // the harness does own is whether that choice is REACHABLE: a link naming a
  // screen the app does not have used to travel all the way to the phone and
  // quietly dump the user on the home screen, which reads exactly like the
  // notification not working. Refusing it here instead puts the correction in
  // front of the model that can still fix it, in the call that got it wrong.
  let deeplink: string | null = null
  if (args.deeplink !== undefined && args.deeplink !== null && args.deeplink !== '') {
    if (!isAllowedDeeplink(args.deeplink)) {
      return failure(
        `invalid argument: deeplink must start with ${DEEPLINK_SCHEME} — got ${String(
          args.deeplink
        ).slice(0, 80)}`
      )
    }
    const target = parseDeeplink(args.deeplink)
    if (!target) {
      return failure(
        `invalid argument: deeplink "${args.deeplink.slice(0, 80)}" is not a screen the phone ` +
          `has. Valid targets: ${EVERY_TARGET} — and chat takes ?id=${CURRENT_CONVERSATION} ` +
          "(this run's own conversation) or ?id=<conversationId> from conversation_list. " +
          'Nothing was sent; correct the link and call once more, or omit deeplink to just ' +
          'open the app.'
      )
    }
    // The one substitution the harness makes, and it is an identity — the same
    // turn scope runId comes from, not a destination of its own choosing.
    if (target.route === 'chat' && target.conversationId === CURRENT_CONVERSATION) {
      const conversationId = scope?.conversationId ?? null
      if (!conversationId) {
        return failure(
          `invalid argument: deeplink asked for ?id=${CURRENT_CONVERSATION}, but this run has no ` +
            'conversation of its own to open. Pass an explicit conversation id from ' +
            'conversation_list, point somewhere else, or omit deeplink. Nothing was sent.'
        )
      }
      deeplink = buildDeeplink({ route: 'chat', conversationId })
    } else {
      // Rebuilt rather than passed through: one canonical shape on the wire is
      // what keeps a phone that parses it naively landing in the right place.
      deeplink = buildDeeplink(target)
    }
  }

  // Straight to the wire. Every notification the model asks for is sent: there
  // is no counter here, no per-phase slot, and no memory of what this run has
  // already said. Whether a moment is worth interrupting the user for is a
  // judgement, and this harness does not take judgements away from the model.
  // It tells it the truth about what happened (below) and lets it decide.
  //
  // What IS guaranteed is that the harness never acts on its own: one call,
  // one frame. See `failure` — every result here is non-retryable, so motor
  // cannot quietly re-fire a send the model made exactly once.
  let result: NotifyResultFrame
  try {
    result = await deps.notify({ title, body, phase, urgency, deeplink, conversationId, runId })
  } catch (error) {
    // Never left this machine — no phone paired, notifications switched off by
    // the user, the relay link down. Nothing about it is unknown, and if the
    // link comes back later in the same run the next call goes.
    return failure(error instanceof Error ? error.message : String(error))
  }

  switch (result.route) {
    case 'inband':
      return success(
        'Delivered to the phone over the live tunnel (it is connected right now). ' +
          `notificationId ${result.notificationId}.`
      )
    case 'push':
      return success(
        'The phone is not connected — queued as a platform push notification via Expo. ' +
          `notificationId ${result.notificationId}.`
      )
    default:
      return failure(
        `the notification's delivery is UNCONFIRMED: ${result.reason ?? 'unknown reason'}. ` +
          'That is not the same as undelivered — it may well be on the phone already, so ' +
          'sending it again risks showing the user the same notification twice. Your call: ' +
          'if it was worth one interruption it is rarely worth two uncertain ones.'
      )
  }
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
