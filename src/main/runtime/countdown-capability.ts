import type { Amygdala } from '@main/runtime/amygdala'
import type { Cerebellum, WolffishPlugin } from '@main/runtime/cerebellum'
import { turnScope } from '@main/runtime/corpus'
import {
  COUNTDOWN_DEFAULT_SECONDS,
  COUNTDOWN_MAX_SECONDS,
  COUNTDOWN_MIN_SECONDS,
  clampSeconds,
  type CountdownManager
} from '@main/runtime/countdown'

/**
 * The `countdown` capability — the model-facing half of runtime/countdown.ts.
 *
 * One tool, `countdown_start`: "run THIS tool call N seconds after my reply
 * is finished, on a card the user can abort". It is the generic form of what
 * `system_power` does for a restart: any action whose effect would land on
 * top of the reply that announces it — or that the user should get a last
 * chance to stop — goes through here instead of running inside the turn.
 *
 * Safety is the SAME gate the direct call would face: the armed target is
 * matched against the amygdala's patterns at arm time and, when it needs
 * confirmation, the approval card is raised now (with the target's own
 * description), never at fire time when no turn is alive to route it.
 * A blocked target is refused outright. What fires later is executed
 * without a second gate — the user already answered.
 */

export const COUNTDOWN_TOOL = 'countdown_start'

export function registerCountdownCapability(
  cerebellum: Cerebellum,
  amygdala: Amygdala,
  countdowns: CountdownManager
): void {
  const plugin: WolffishPlugin = {
    name: 'countdown',
    tools: [],
    execute: async (toolName, args) => {
      if (toolName !== COUNTDOWN_TOOL) {
        return { success: false, error: `countdown: unknown tool ${toolName}` }
      }
      const label = typeof args?.label === 'string' ? args.label.trim() : ''
      const tool = typeof args?.tool === 'string' ? args.tool.trim() : ''
      const targetArgs =
        args?.args && typeof args.args === 'object' && !Array.isArray(args.args)
          ? (args.args as Record<string, unknown>)
          : {}
      if (!label)
        return { success: false, error: "label is required — what fires, in the user's words." }
      if (!tool) return { success: false, error: 'tool is required — the tool call that fires.' }
      if (tool === COUNTDOWN_TOOL) {
        return { success: false, error: 'A countdown cannot arm another countdown.' }
      }
      if (!cerebellum.hasTool(tool)) {
        return {
          success: false,
          error: `Unknown tool "${tool}". Use a tool that is callable right now (tool_search can load one).`
        }
      }
      const scope = turnScope.getStore()
      if (!scope?.turnId) {
        return {
          success: false,
          error: 'A countdown can only be armed from inside a running turn.'
        }
      }
      if (scope.autonomous) {
        return {
          success: false,
          error:
            'Countdowns are refused in an automation run: nobody is watching the card to abort it. Report what should happen instead.'
        }
      }

      // Gate the TARGET now, exactly as a direct call would be gated.
      const call = { id: `countdown_${Date.now().toString(36)}`, name: tool, args: targetArgs }
      const match = amygdala.match(call)
      const level = match?.level ?? 'safe'
      if (level === 'block') {
        return { success: false, error: `Blocked by safety policy: ${match?.reason ?? 'blocked'}` }
      }
      if ((level === 'confirm' || level === 'destructive') && !amygdala.isBypassingPermissions()) {
        const description = await cerebellum
          .describeToolCall(tool, targetArgs)
          .catch(() => undefined)
        const decision = await amygdala.requestApproval({
          toolCall: call,
          level,
          reason: match?.reason ?? 'requires confirmation',
          description: description
            ? {
                ...description,
                description: `${description.description} Runs ${clampSeconds(args?.seconds)} seconds after this reply, unless aborted from the countdown card.`
              }
            : undefined,
          sessionKey: scope.conversationId ?? scope.turnId
        })
        if (decision === 'denied') {
          return {
            success: false,
            error: `Denied by user: ${match?.reason ?? 'requires confirmation'}`
          }
        }
      }

      const result = await countdowns.arm(scope.conversationId, scope.turnId, {
        label,
        seconds: clampSeconds(args?.seconds ?? COUNTDOWN_DEFAULT_SECONDS),
        tool,
        args: targetArgs
      })
      if (!result.ok) return { success: false, error: result.error }
      const { seconds } = result.snapshot
      return {
        success: true,
        output:
          `Armed: "${label}" runs ${tool} ${seconds} seconds after this reply is complete. ` +
          'Do not call it yourself. Make this reply your LAST action of the turn — finish, then tell the user in one line what happens in ' +
          `${seconds} seconds and that the card in the chat has an Abort button. Nothing runs until the turn ends; a Stop drops it.`,
        meta: { label: 'Countdown armed' }
      }
    }
  }

  cerebellum.registerInProcessCapability(
    {
      name: 'countdown',
      dir: '',
      description:
        'Run a tool call a few seconds AFTER your reply is finished, on a card the user can abort. For any action that would cut off the reply announcing it (restart, shutdown, logout, closing this app) or that deserves a last chance to stop.',
      triggers: {
        keywords: [
          'countdown',
          'in a few seconds',
          'after this message',
          'give me a chance to cancel'
        ]
      },
      tools: [
        {
          name: COUNTDOWN_TOOL,
          description:
            'Arm a tool call to run N seconds after this turn ends, shown in the chat as a countdown card with an Abort button. Nothing runs now: the turn finishes, its transcript is saved, THEN the clock starts. Use it for any action whose effect would land on the reply that announces it — restarting or shutting down the machine, logging out, quitting this app — or for an irreversible step the user should get a last chance to stop. The target is checked against the same safety rules as calling it directly, and any approval is asked for now. After arming, make your reply the final action of the turn and tell the user what happens in N seconds and that the card can abort it. A Stop on this turn drops the countdown; arming a second one replaces the first. NOT for waiting: if you just need time to pass and then want to keep working yourself, call `wait` instead — this tool ends your turn and fires ONE call with nothing after it.',
          parameters: {
            label: {
              type: 'string',
              required: true,
              description:
                'What fires, in the user\'s words, as the card\'s title — e.g. "Restart this Mac", "Quit Wolffish", "Delete the old backups".'
            },
            tool: {
              type: 'string',
              required: true,
              description: 'The tool to run when the countdown ends — a tool callable right now.'
            },
            args: {
              type: 'object',
              required: false,
              description: 'The arguments to pass to that tool, exactly as you would call it.'
            },
            seconds: {
              type: 'integer',
              required: false,
              description: `Grace period after the turn ends, ${COUNTDOWN_MIN_SECONDS}-${COUNTDOWN_MAX_SECONDS}. Default ${COUNTDOWN_DEFAULT_SECONDS}. Raise it if a download or a long write you started is still running — the delay is its only window to finish.`
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
