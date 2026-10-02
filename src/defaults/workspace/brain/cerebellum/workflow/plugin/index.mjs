/**
 * workflow — Wolffish designs and drives model-led multi-agent runs.
 *
 * Tools to plan phases and to spawn, follow up, await, and cancel live agent
 * sessions. Each agent is a real agent turn — on the master's model or a
 * per-agent model the master picks — with the normal toolset MINUS channel
 * egress, MINUS ask_user, and MINUS delegation (two-level: an agent never
 * spawns agents and never messages the user). Execution is event-driven:
 * plan/spawn/send return at once and the agent runs in the background;
 * agents_await blocks only until the NEXT agent lands, so the master reacts
 * per-completion instead of stalling on the slowest.
 *
 * All agent state — the registry, the abort controllers, the completion
 * queue, the deterministic card telemetry — lives behind the `workflow` host
 * bridge injected at init (PluginContext.workflow), implemented over the
 * Agent's active WorkflowSession. Nothing is touched by hand here; the bridge
 * is the single source of truth so an agent can never be orphaned.
 *
 * NOTE: the model-facing tool schemas live in ../SKILL.md frontmatter (that
 * is what cerebellum ships to the API); keep them in sync with this file.
 */

// Agent-management bridge, injected at init by the main process. Present only
// to the master role in workflow mode; undefined otherwise.
let workflow

function missingBridge() {
  return {
    success: false,
    error:
      'The workflow tools are unavailable — workflow mode is not active for this turn. Just do the work yourself.'
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : `${v ?? ''}`.trim()
}

const EFFORTS = new Set(['off', 'on', 'high', 'max'])
function effortOf(v) {
  const e = str(v)
  return EFFORTS.has(e) ? e : undefined
}

function liveSummary(excludeId) {
  const others = workflow
    .listAgents()
    .filter((a) => a.id !== excludeId && (a.status === 'running' || a.status === 'queued'))
  if (others.length === 0) return 'No other agents are live.'
  return `Still live: ${others.map((a) => `${a.id} (${a.name})`).join(', ')}.`
}

function planPhases(args) {
  if (!workflow) return missingBridge()
  const phases = Array.isArray(args?.phases) ? args.phases.map(str).filter(Boolean) : []
  if (phases.length === 0) {
    return { success: false, error: 'workflow_plan: provide `phases` as a non-empty array of titles.' }
  }
  try {
    workflow.plan(phases, str(args?.note) || undefined)
  } catch (err) {
    return { success: false, error: `workflow_plan: ${err instanceof Error ? err.message : String(err)}` }
  }
  // A first plan (no agents yet) reads back the contract in-band: the card
  // this call just drew is an empty agent table until agent_spawn fills it.
  if (workflow.listAgents().length === 0) {
    return {
      success: true,
      output: `Plan recorded (${phases.join(' → ')}). The user's card now shows these phases over an EMPTY agent table ("No agents spawned yet.") and stays that way until you spawn — agent_spawn the phase work now, passing \`phase\`. If you meant to do this work yourself, planning was the wrong call: the card cannot be removed, so run the substantive phases through agents.`
    }
  }
  return {
    success: true,
    output: `Plan updated (${phases.join(' → ')}). Assign agents to phases via agent_spawn's \`phase\`.`
  }
}

function spawnAgent(args) {
  if (!workflow) return missingBridge()
  const task = str(args?.task)
  if (!task) return { success: false, error: 'agent_spawn: provide a `task`.' }
  const name = str(args?.name)
  const model = str(args?.model)
  const effort = effortOf(args?.effort)
  const phase = str(args?.phase)
  let id
  try {
    id = workflow.spawnAgent({
      task,
      name: name || undefined,
      model: model || undefined,
      effort,
      phase: phase || undefined,
      readOnly: args?.readOnly === true
    })
  } catch (err) {
    return { success: false, error: `agent_spawn: ${err instanceof Error ? err.message : String(err)}` }
  }
  const bits = [
    name ? `(${name})` : '',
    model ? `on ${model}` : '',
    effort ? `at ${effort} effort` : '',
    phase ? `in phase "${phase}"` : ''
  ]
    .filter(Boolean)
    .join(' ')
  return {
    success: true,
    output: `Spawned agent ${id}${bits ? ` ${bits}` : ''}. It's running in the background — spawn more now for parallelism, then call agents_await to collect results as they land.`
  }
}

function sendAgent(args) {
  if (!workflow) return missingBridge()
  const id = str(args?.agent_id)
  const message = str(args?.message)
  if (!id) return { success: false, error: 'agent_send: provide an `agent_id`.' }
  if (!message) return { success: false, error: 'agent_send: provide a `message`.' }
  try {
    workflow.sendToAgent(id, message, effortOf(args?.effort))
  } catch (err) {
    return { success: false, error: `agent_send: ${err instanceof Error ? err.message : String(err)}` }
  }
  return {
    success: true,
    output: `Sent follow-up to ${id}; it's running again with its full prior context. Collect it with agents_await.`
  }
}

async function awaitAgents(args) {
  if (!workflow) return missingBridge()
  const ids = Array.isArray(args?.agent_ids) ? args.agent_ids.map(str).filter(Boolean) : undefined
  let outcome
  try {
    outcome = await workflow.awaitAgents(ids && ids.length ? ids : undefined)
  } catch (err) {
    return { success: false, error: `agents_await: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (!outcome) {
    return {
      success: true,
      output:
        ids && ids.length
          ? 'None of those agents are still live — nothing to await.'
          : 'No agents are live — nothing to await. Spawn some, or finish up.'
    }
  }
  const { id, name } = outcome
  // A still-running agent that is stuck re-issuing the same call. NOT finished —
  // no result yet. It has ALSO been told (in its own runtime feed) to wrap up,
  // so waiting a little longer may let it conclude on its own with partial
  // findings. You manage it: keep waiting, or cancel it (losing its in-progress
  // work) and cover its slice another way. agent_send does NOT work on a running
  // agent — cancel and respawn if you want to redirect it.
  if (outcome.kind === 'no_progress') {
    const s = outcome.signal
    return {
      success: true,
      output: [
        `⚠️ Agent ${id} (${name}) is STILL RUNNING but appears STUCK — no result yet.`,
        `It has issued the same tool call (\`${s.label}\`) ${s.repeats} times to no effect (only ${s.distinct} distinct calls in its last ${s.windowSize}).`,
        '',
        `You decide: call agents_await again to let it wrap up on its own with what it has, or agent_cancel ${id} (its in-progress work is lost) and cover its part yourself or via a fresh, tighter-scoped agent.`,
        '',
        liveSummary(id)
      ].join('\n')
    }
  }
  const { result } = outcome
  const meta = result.failed
    ? `[FAILED: ${result.stopReason} — decide: respawn with a fix, try another model, or absorb the slice yourself]`
    : `[finished: ${result.stopReason}]`
  return {
    success: true,
    output: [
      `Agent ${id} (${name}) landed. ${meta}`,
      '',
      result.text,
      '',
      `${liveSummary(id)} ${id} is idle — agent_send to follow up. Call agents_await again for the next landing.`
    ].join('\n')
  }
}

function cancelAgent(args) {
  if (!workflow) return missingBridge()
  const id = str(args?.agent_id)
  if (!id) return { success: false, error: 'agent_cancel: provide an `agent_id`.' }
  try {
    workflow.cancelAgent(id)
  } catch (err) {
    return { success: false, error: `agent_cancel: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { success: true, output: `Cancelled ${id} — its in-flight work was aborted.` }
}

const plugin = {
  name: 'workflow',
  async init(context) {
    workflow = context?.workflow
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'workflow_plan':
        return planPhases(args ?? {})
      case 'agent_spawn':
        return spawnAgent(args ?? {})
      case 'agent_send':
        return sendAgent(args ?? {})
      case 'agents_await':
        return awaitAgents(args ?? {})
      case 'agent_cancel':
        return cancelAgent(args ?? {})
      default:
        return { success: false, error: `workflow: unknown tool ${toolName}` }
    }
  }
}

export default plugin
