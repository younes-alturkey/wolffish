/**
 * procedures — Wolffish manages its own saved prompts.
 *
 * Tools to list, view, create, edit, delete, and run "procedures": reusable
 * prompts the user keeps on the Procedures page and runs on demand (there's no
 * schedule — that's what `automations` is for). Everything is reached through
 * the `procedures` host bridge injected at init (PluginContext.procedures),
 * implemented in the main process over the very same store the Procedures page
 * reads and writes, so the agent's view can never drift from the user's.
 *
 * `procedure_run` fires the saved prompt through the Brainstem's bounded run
 * pool (up to three concurrent runs) — the identical machinery a triggered
 * automation uses — so it runs to completion by itself as a sealed conversation
 * that lands in history, while the current conversation carries on.
 */

// Procedure-management bridge, injected at init by the main process.
let procedures

const toolDefinitions = [
  {
    name: 'procedure_list',
    description:
      'List every saved procedure (a reusable prompt the user runs on demand): its number, title, a one-line preview of the prompt, and any files or working folders attached to it. Use this before viewing, editing, deleting, or running one so you reference it by the correct number or title.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'procedure_view',
    description:
      "Show one procedure's full title and complete prompt body (procedure_list only previews the prompt). Identify it by the number from procedure_list, its exact title, or its id.",
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'The procedure to view — its 1-based number from procedure_list, its exact title, or its id.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'procedure_create',
    description:
      'Save a new procedure: a reusable prompt the user (or you, via procedure_run) can run on demand from a fresh conversation. Provide a short title and the full prompt text.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short, descriptive name for the procedure (required, shown on its card).'
        },
        prompt: {
          type: 'string',
          description:
            'The full prompt to run when the procedure is played. Write it self-contained — a run starts a brand-new conversation with no prior context.'
        }
      },
      required: ['title', 'prompt']
    }
  },
  {
    name: 'procedure_edit',
    description:
      "Change a procedure's title and/or its prompt. Identify it by the number from procedure_list, its exact title, or its id. Provide title, prompt, or both — whatever you omit is kept.",
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'The procedure to edit — its 1-based number from procedure_list, its exact title, or its id.'
        },
        title: {
          type: 'string',
          description: 'New title. Omit to keep the current title. Cannot be empty.'
        },
        prompt: {
          type: 'string',
          description: 'New prompt body. Omit to keep the current prompt.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'procedure_delete',
    description:
      'Permanently delete a saved procedure. Identify it by the number from procedure_list, its exact title, or its id.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'The procedure to delete — its 1-based number from procedure_list, its exact title, or its id.'
        }
      },
      required: ['identifier']
    }
  },
  {
    name: 'procedure_run',
    description:
      'Run a saved procedure right now — its prompt runs to completion by itself in a background sealed conversation that appears in history, exactly like a triggered automation, while this conversation continues. Identify it by number, title, or id.',
    parameters: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description:
            'The procedure to run — its 1-based number from procedure_list, its exact title, or its id.'
        }
      },
      required: ['identifier']
    }
  }
]

// ---------------------------------------------------------------------------
// Identifier resolution — number (over the same list the agent just saw),
// exact title, or raw id. Mirrors the automations resolution discipline.
// ---------------------------------------------------------------------------

async function resolveTarget(rawIdentifier) {
  const list = await procedures.list()
  if (list.length === 0) {
    return { error: 'There are no saved procedures yet. Use procedure_create first.' }
  }
  const identifier =
    typeof rawIdentifier === 'string' ? rawIdentifier.trim() : `${rawIdentifier ?? ''}`.trim()
  if (!identifier) {
    return { error: 'Provide an `identifier` — a number from procedure_list, an exact title, or an id.' }
  }
  // 1-based index into the procedure_list ordering (updatedAt DESC).
  const asNum = Number(identifier)
  if (Number.isInteger(asNum) && String(asNum) === identifier) {
    if (asNum >= 1 && asNum <= list.length) return { proc: list[asNum - 1] }
    return {
      error: `There is no procedure #${asNum}. There ${list.length === 1 ? 'is 1' : `are ${list.length}`}. Run procedure_list.`
    }
  }
  // Exact id.
  const byId = list.find((p) => p.id === identifier)
  if (byId) return { proc: byId }
  // Exact title (case-insensitive).
  const lower = identifier.toLowerCase()
  const exact = list.filter((p) => (p.title || '').trim().toLowerCase() === lower)
  if (exact.length === 1) return { proc: exact[0] }
  if (exact.length > 1) {
    return { error: `"${identifier}" matches ${exact.length} procedures — use the number from procedure_list instead.` }
  }
  return { error: `No procedure matches "${identifier}". Run procedure_list to see the numbers and titles.` }
}

// ---------------------------------------------------------------------------
// procedure_list
// ---------------------------------------------------------------------------

async function listProceduresTool() {
  if (!procedures) return missingBridge()
  const list = await procedures.list()
  if (list.length === 0) {
    return {
      success: true,
      output:
        'No procedures saved yet. Use `procedure_create` to save a reusable prompt the user can run on demand.'
    }
  }
  const lines = [`## Procedures (${list.length})`, '']
  list.forEach((p, i) => {
    const title = (p.title || '').trim() || '(untitled)'
    const empty = (p.prompt || '').trim().length === 0
    lines.push(`${i + 1}. **${title}** — edited ${relativeTime(p.updatedAt)}${empty ? ' · ⚠ no prompt yet' : ''}`)
    lines.push(`   ${oneLine(p.prompt) || '(no prompt yet)'}`)
    // Attached files and working folders are part of what a procedure IS —
    // every run is told about both, so a list that hid them would misdescribe
    // the procedure. They are attached in the app, not from here.
    for (const file of p.files ?? []) lines.push(`   file: \`${file.path}\``)
    for (const dir of p.directories ?? []) lines.push(`   working folder: \`${dir}\``)
    lines.push('')
  })
  lines.push(
    'View the full prompt with `procedure_view`, run one with `procedure_run`, or change it with `procedure_edit` — reference by number or exact title.'
  )
  return { success: true, output: lines.join('\n').trim() }
}

// ---------------------------------------------------------------------------
// procedure_view
// ---------------------------------------------------------------------------

async function viewProcedure(args) {
  if (!procedures) return missingBridge()
  const target = await resolveTarget(args?.identifier)
  if (target.error) return { success: false, error: target.error }
  const p = target.proc
  const title = (p.title || '').trim() || '(untitled)'
  return {
    success: true,
    output: [
      `## ${title}`,
      `edited ${relativeTime(p.updatedAt)}`,
      '',
      '```',
      (p.prompt || '').trim() || '(no prompt yet)',
      '```'
    ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// procedure_create
// ---------------------------------------------------------------------------

async function createProcedureTool(args) {
  if (!procedures) return missingBridge()
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  const prompt = typeof args?.prompt === 'string' ? args.prompt.trim() : ''
  if (!title) return { success: false, error: 'procedure_create: provide a `title`.' }
  if (!prompt) return { success: false, error: 'procedure_create: provide a `prompt` to save.' }

  const created = await procedures.create(title, prompt)
  return {
    success: true,
    output: `Saved procedure "${created.title}". Run it anytime with \`procedure_run\` (by number or title), or the user can hit Play on the Procedures page to run it in a fresh conversation.`
  }
}

// ---------------------------------------------------------------------------
// procedure_edit
// ---------------------------------------------------------------------------

async function editProcedureTool(args) {
  if (!procedures) return missingBridge()
  const target = await resolveTarget(args?.identifier)
  if (target.error) return { success: false, error: target.error }

  const hasTitle = typeof args?.title === 'string'
  const hasPrompt = typeof args?.prompt === 'string'
  if (!hasTitle && !hasPrompt) {
    return { success: false, error: 'procedure_edit: provide a new `title`, a new `prompt`, or both.' }
  }
  const patch = {}
  if (hasTitle) {
    const title = args.title.trim()
    if (!title) return { success: false, error: 'procedure_edit: `title` cannot be empty.' }
    patch.title = title
  }
  if (hasPrompt) patch.prompt = args.prompt.trim()

  const updated = await procedures.update(target.proc.id, patch)
  return { success: true, output: `Updated procedure "${(updated.title || '').trim() || '(untitled)'}".` }
}

// ---------------------------------------------------------------------------
// procedure_delete
// ---------------------------------------------------------------------------

async function deleteProcedureTool(args) {
  if (!procedures) return missingBridge()
  const target = await resolveTarget(args?.identifier)
  if (target.error) return { success: false, error: target.error }
  const title = (target.proc.title || '').trim() || '(untitled)'
  const result = await procedures.delete(target.proc.id)
  if (!result.ok) {
    return { success: false, error: `procedure_delete: couldn't delete — ${result.error ?? 'unknown error'}` }
  }
  return { success: true, output: `Deleted procedure "${title}". It's gone from the Procedures page.` }
}

// ---------------------------------------------------------------------------
// procedure_run
// ---------------------------------------------------------------------------

async function runProcedureTool(args) {
  if (!procedures) return missingBridge()
  const target = await resolveTarget(args?.identifier)
  if (target.error) return { success: false, error: target.error }
  const p = target.proc
  const title = (p.title || '').trim() || '(untitled)'
  if ((p.prompt || '').trim().length === 0) {
    return { success: false, error: `Procedure "${title}" has no prompt to run. Add one with procedure_edit first.` }
  }

  const outcome = await procedures.run(p.id)
  if (!outcome.ok) return { success: false, error: `procedure_run: ${outcome.error ?? 'could not run.'}` }
  if (!outcome.started) {
    return {
      success: true,
      output: `Did not start "${title}" immediately: ${outcome.error ?? 'all run slots are busy.'} It's queued (or already in flight) and runs once a slot frees up — no need to retry.`
    }
  }
  return {
    success: true,
    output: `Started "${title}" in the background — it runs to completion on its own as a sealed conversation and appears in history when it finishes, exactly like a triggered automation. Keep talking to the user in this conversation. Do NOT poll in a loop waiting for it: you can't pause between tool calls, so looping just burns turns and cannot make it finish sooner. Tell the user it's running; if they later ask how it went, point them to the conversation in history.`
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function missingBridge() {
  return {
    success: false,
    error:
      'Procedure management is unavailable in this context (no host bridge). This should not happen inside the app — report it.'
  }
}

/** Collapse a prompt to a single line for compact display. */
function oneLine(text) {
  const flat = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat
}

function relativeTime(epochMs) {
  const diff = Date.now() - epochMs
  if (diff < 0) return 'just now'
  const sec = Math.round(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.round(hr / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

const plugin = {
  name: 'procedures',
  tools: toolDefinitions,
  async init(context) {
    procedures = context?.procedures
  },
  async execute(toolName, args) {
    switch (toolName) {
      case 'procedure_list':
        return listProceduresTool()
      case 'procedure_view':
        return viewProcedure(args ?? {})
      case 'procedure_create':
        return createProcedureTool(args ?? {})
      case 'procedure_edit':
        return editProcedureTool(args ?? {})
      case 'procedure_delete':
        return deleteProcedureTool(args ?? {})
      case 'procedure_run':
        return runProcedureTool(args ?? {})
      default:
        return { success: false, error: `procedures: unknown tool ${toolName}` }
    }
  }
}

export default plugin
