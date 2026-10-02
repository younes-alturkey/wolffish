---
name: workflow
description: Design and drive a model-led workflow — declare phases, spawn live parallel agents on models you choose, collect each result as it lands, and steer or cancel agents. Available only to the workflow master; agents never get these tools.
tools:
  - name: workflow_plan
    description: Declare (or revise) the phases of this run — e.g. ["analysis", "build", "critique", "verify"]. Calling this commits you to spawning agents into these phases — the card it draws renders agent telemetry only, so a plan whose phases no agent ever runs shows the user a broken, empty card ("No agents spawned yet."). Doing the work yourself? Skip the plan entirely — no plan, no card. Call it again anytime the plan changes; assign agents to phases via agent_spawn's phase argument.
    parameters:
      phases:
        type: array
        items:
          type: string
        description: Ordered phase titles for this run, short and human-readable (e.g. "analysis", "adversarial review"). Replaces any previously declared plan.
      note:
        type: string
        required: false
        description: One short line about the overall approach, shown on the card. Optional.
  - name: agent_spawn
    description: Start a live agent running in the background on a task. Returns immediately with the agent's id (it does NOT wait for the agent to finish) — spawn several in a row to run them in parallel. The agent is a full tool-using Wolffish agent minus channel sending, minus user questions, and minus these workflow tools (it cannot message the user or spawn agents). Compose a self-contained task; the agent sees only what you write here, never the user conversation.
    parameters:
      task:
        type: string
        description: The complete, self-contained task for the agent. Include every fact it needs — it has no access to the user conversation or to the other agents. Say exactly what to produce and return.
      name:
        type: string
        required: false
        description: A short human name for this agent (e.g. "research-pricing", "skeptic-1"). Shown on the workflow card. Optional.
      model:
        type: string
        required: false
        description: Which model runs this agent, as "provider/model-id" exactly as listed in <workflow_models> (e.g. "anthropic/claude-fable-5", "deepseek/deepseek-chat"). Pick per difficulty — frontier models for hard reasoning slices, cheaper/faster models for mechanical ones. Stay within your own provider's family; you may cross to another family when the slice clearly benefits. Omit to run the agent on your own model.
      effort:
        type: string
        required: false
        enum: ['off', 'on', 'high', 'max']
        description: How hard this agent should reason — 'off' (fastest, for mechanical work), 'on' (light), 'high' (deep, the default for substantive work), 'max' (hardest sub-tasks only). Clamped to what the chosen model supports. Optional.
      phase:
        type: string
        required: false
        description: The workflow_plan phase this agent belongs to (exact title). Drives the card's per-phase progress. Optional.
      readOnly:
        type: boolean
        required: false
        description: 'Spawn a read-only EXPLORE agent: it can read, search, list, fetch and recall but every call that would change state (file writes, edits, shell commands that mutate, sends) is refused for its whole run. Use it for open-ended questions about a codebase or a folder ("how does X work", "where is Y handled", "what would this change touch") so your own context stays lean and nothing can be altered by accident. Give it the thoroughness you want ("quick", "medium", "very thorough") and ask for absolute paths in its report.'
  - name: agent_send
    description: Send a follow-up to an agent that has finished its previous task and is idle. Returns immediately; the agent runs again on the new message with its full prior context intact. Use this to iterate — a revision, a deeper pass, the next step. (An agent that is still running can only be cancelled and respawned.)
    parameters:
      agent_id:
        type: string
        description: The id returned by agent_spawn (e.g. "a1").
      message:
        type: string
        description: The follow-up instruction. The agent remembers its earlier runs.
      effort:
        type: string
        required: false
        enum: ['off', 'on', 'high', 'max']
        description: Optionally re-tune the agent's reasoning effort for this and later runs. Omit to keep its current level.
  - name: agents_await
    description: Block until the NEXT agent finishes and return its full report. This is how you collect work. It returns the moment ONE agent lands — it does NOT wait for all of them; the rest keep running and you collect them with further agents_await calls. React to each result as it arrives. Returns nothing-left when no targeted agent is still live. It can ALSO return early with a ⚠️ NO-PROGRESS notice about a still-running agent that is stuck re-issuing the same tool call to no effect (it has no result yet, and has itself been told to wrap up). You decide — agents_await again to let it conclude with partial findings, or agent_cancel it (losing its in-progress work) and cover its slice another way. This is how you stay in control instead of blocking forever on a runaway agent.
    parameters:
      agent_ids:
        type: array
        required: false
        items:
          type: string
        description: Restrict to these agent ids — return only when one of THEM lands. Omit to wait on the next of ANY live agent.
  - name: agent_cancel
    description: Cancel an agent immediately, aborting whatever it is doing right now (its in-flight tool call is killed). Use this when an agent is off-track, superseded, or no longer needed — cancel-and-respawn is also how you steer an agent that is mid-run.
    parameters:
      agent_id:
        type: string
        description: The id of the agent to cancel.
---

# Workflow — design and drive a model-led run

These tools exist so YOU can architect the execution of a task: break it into
phases, fan independent slices out to parallel agents on models you choose,
collect each result the moment it lands, pit agents against each other for
adversarial verification, and synthesize one answer in your own voice.

The workflow is never fixed. You design it per task — a quick question needs
no agents at all; a hard deliverable might get analysis agents, builder agents,
skeptic agents, and a verify pass. The user sees a live workflow card built
from the harness's own telemetry (statuses, tokens, time, tool calls) — your
job is the work, not the reporting.

## The loop

1. `workflow_plan` the phases when the task is big enough to phase — it
   commits you to spawning agents into them; solo work takes no plan and
   no card.
2. `agent_spawn` the independent slices — several at once for parallelism,
   each with a complete, self-contained task and a model matched to its
   difficulty.
3. `agents_await` — it returns on the FIRST landing; read the report, decide,
   spawn/steer/cancel, await again. Never stall on the slowest agent.
4. Verify: spawn skeptics/checkers against produced work before trusting it.
5. Synthesize the final answer yourself, in one voice.

The full playbook lives in your workflow-mode system prompt.
