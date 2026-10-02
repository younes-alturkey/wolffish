/**
 * knowledge — the write surface over Wolffish's own long-term beliefs:
 * add a new one, amend a stale one, forget one that is no longer true.
 *
 * Thin by design: every rule (the nine-file allowlist, the structure
 * invariants, the size ceilings, the `.bak` safety net, the unique-match
 * guard) lives in main's KnowledgeStore, because those files must only ever be
 * written through diskWriter. This plugin validates the target name, calls the
 * bridge, and formats the result for the model.
 */

let knowledgeBridge = null
let targets = []

const TARGET_ENUM = [
  'playbook',
  'instructions',
  'soul',
  'user',
  'projects',
  'people',
  'preferences',
  'technical',
  'decisions'
]

const toolDefinitions = [
  {
    name: 'knowledge_list',
    description:
      'Map every long-term belief file you can write to: what each governs, its size and ceiling, its section headings (the topics you add entries under and edit by), how many entries it holds, and whether it rides in every prompt. Start here when you have something to record or correct and are not sure which file holds it.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'knowledge_read',
    description:
      'Read one long-term file in full, verbatim. Always read before editing — knowledge_edit and knowledge_forget need the entry copied exactly, and they refuse an ambiguous match rather than guess which belief you meant.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: TARGET_ENUM, description: 'Which file to read.' }
      },
      required: ['target']
    }
  },
  {
    name: 'knowledge_add',
    description:
      'Record a new durable belief: a behavioural lesson (playbook), a standing procedure the user dictates (instructions), a fact about them or about you. Files the entry under the right `##` topic, which is what keeps a fact about one person from landing under another — memory_save is the quicker path only for a plain fact in a file with no topics yet. Adding needs no invitation; removing does.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: TARGET_ENUM, description: 'Which file to add to.' },
        entry: { type: 'string', description: 'One tight, self-contained line.' },
        section: {
          type: 'string',
          description:
            'Section heading to file it under (created if missing). REQUIRED for playbook — one of: Do, Avoid, User likes, User dislikes, Recipes.'
        },
        source: {
          type: 'string',
          enum: ['user-said', 'inferred'],
          description:
            "Playbook only — where the lesson came from (default user-said). Today's date is stamped automatically; inferred entries decay after 30 days unless reinforced."
        }
      },
      required: ['target', 'entry']
    }
  },
  {
    name: 'knowledge_edit',
    description:
      'Amend an existing entry in place — the correction path when a belief is stale or partly wrong. `find` must match exactly one entry; copy it verbatim from knowledge_read. The previous version of the file is kept, so knowledge_restore undoes it.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: TARGET_ENUM, description: 'Which file holds the entry.' },
        find: {
          type: 'string',
          description: 'The existing entry, copied verbatim (a unique excerpt is enough).'
        },
        replace: { type: 'string', description: 'The corrected entry that replaces it.' }
      },
      required: ['target', 'find', 'replace']
    }
  },
  {
    name: 'knowledge_forget',
    description:
      'UNLEARN — delete an entry outright. Use when a belief is simply wrong, no longer true, or the user tells you to stop doing something you learned. The whole entry goes (not just the matched words) and a section left empty is pruned. Prefer this over adding a contradicting line: two entries that disagree is worse than one that is missing. Undoable with knowledge_restore.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: TARGET_ENUM, description: 'Which file holds the entry.' },
        find: {
          type: 'string',
          description: 'The entry to remove, copied verbatim (a unique excerpt is enough).'
        }
      },
      required: ['target', 'find']
    }
  },
  {
    name: 'knowledge_rewrite',
    description:
      'Replace a whole file — the restructuring path when many entries need merging, re-homing, or reordering at once. Send the COMPLETE file including its "# Header" line; a fragment is rejected. Prefer knowledge_edit / knowledge_forget for anything smaller.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: TARGET_ENUM, description: 'Which file to replace.' },
        content: {
          type: 'string',
          description: 'The complete new file content, starting with its "# Header" line.'
        }
      },
      required: ['target', 'content']
    }
  },
  {
    name: 'knowledge_restore',
    description:
      'Undo the last change to a long-term file by swapping it with its backup. Restoring again swaps back, so it is always safe to try.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', enum: TARGET_ENUM, description: 'Which file to restore.' } },
      required: ['target']
    }
  }
]

function unavailable() {
  return { success: false, error: 'knowledge bridge unavailable' }
}

function resolveTarget(args) {
  const target = typeof args?.target === 'string' ? args.target.trim().toLowerCase() : ''
  const allowed = targets.length > 0 ? targets : TARGET_ENUM
  if (!allowed.includes(target)) {
    return { error: `Unknown target "${args?.target ?? ''}" — pick one of: ${allowed.join(', ')}.` }
  }
  return { target }
}

/** Fold a store result into the tool-result shape, keeping non-blocking warnings visible. */
function present(result) {
  if (!result?.ok) return { success: false, error: result?.error ?? 'write failed' }
  return {
    success: true,
    output: result.warning ? `${result.message}\nNote: ${result.warning}` : result.message
  }
}

async function list() {
  if (!knowledgeBridge) return unavailable()
  const rows = await knowledgeBridge.list()
  const lines = [
    'Your writable long-term memory. Record with knowledge_add, correct with knowledge_edit, unlearn with knowledge_forget.',
    ''
  ]
  for (const r of rows) {
    const size = r.bytes === 0 ? 'empty' : `${r.bytes}/${r.maxChars} chars`
    const prompt = r.everyPrompt ? 'in every prompt' : 'retrieved on demand'
    lines.push(`## ${r.target} — ${r.rel}`)
    lines.push(`${r.governs}.`)
    lines.push(
      `${size}, ${r.entries} ${r.entries === 1 ? 'entry' : 'entries'}, ${prompt}${
        r.hasBackup ? ', backup available' : ''
      }${r.updatedAt ? `, updated ${r.updatedAt.slice(0, 10)}` : ''}`
    )
    if (r.sections.length > 0) lines.push(`sections: ${r.sections.join(' | ')}`)
    lines.push('')
  }
  return { success: true, output: lines.join('\n').trim() }
}

async function read(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  const result = await knowledgeBridge.read(resolved.target)
  if (!result.ok) return { success: false, error: result.error }
  if (!result.content.trim()) {
    return { success: true, output: `${result.rel} is empty — nothing recorded there yet.` }
  }
  return { success: true, output: `${result.rel}\n\n${result.content}` }
}

async function add(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  const entry = typeof args?.entry === 'string' ? args.entry : ''
  return present(
    await knowledgeBridge.add(resolved.target, entry, {
      section: typeof args?.section === 'string' ? args.section : undefined,
      source: typeof args?.source === 'string' ? args.source : undefined
    })
  )
}

async function edit(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  return present(
    await knowledgeBridge.edit(
      resolved.target,
      typeof args?.find === 'string' ? args.find : '',
      typeof args?.replace === 'string' ? args.replace : ''
    )
  )
}

async function forget(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  return present(
    await knowledgeBridge.forget(
      resolved.target,
      typeof args?.find === 'string' ? args.find : ''
    )
  )
}

async function rewrite(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  return present(
    await knowledgeBridge.rewrite(
      resolved.target,
      typeof args?.content === 'string' ? args.content : ''
    )
  )
}

async function restore(args) {
  if (!knowledgeBridge) return unavailable()
  const resolved = resolveTarget(args)
  if (resolved.error) return { success: false, error: resolved.error }
  return present(await knowledgeBridge.restore(resolved.target))
}

const plugin = {
  name: 'knowledge',
  tools: toolDefinitions,

  async init(context) {
    knowledgeBridge = context?.knowledge ?? null
    try {
      targets = knowledgeBridge?.targets?.() ?? []
    } catch {
      targets = []
    }
  },

  /**
   * The approval card for a gated call (whole-file rewrite, soul edit) shows
   * WHICH belief file and WHAT the change is — approving "knowledge_rewrite"
   * without seeing the target is not consent.
   */
  describeAction(toolName, args) {
    const target = typeof args?.target === 'string' ? args.target : '(unspecified)'
    const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
    if (toolName === 'knowledge_rewrite') {
      const size = typeof args?.content === 'string' ? args.content.length : 0
      return {
        title: `Replace long-term memory: ${target}`,
        description: `Rewrites the whole ${target} file (${size} chars) in one write.`,
        impact: 'The current version is kept as a backup — knowledge_restore swaps it back.',
        risk: 'medium'
      }
    }
    if (toolName === 'knowledge_forget') {
      return {
        title: `Forget from ${target}`,
        description: `Deletes the entry matching: ${clip(args?.find, 200)}`,
        impact: 'Undoable with knowledge_restore.',
        risk: 'medium'
      }
    }
    if (toolName === 'knowledge_edit') {
      return {
        title: `Amend ${target}`,
        description: `"${clip(args?.find, 120)}" becomes "${clip(args?.replace, 120)}"`,
        impact: 'Undoable with knowledge_restore.',
        risk: 'low'
      }
    }
    if (toolName === 'knowledge_add') {
      return {
        title: `Add to ${target}`,
        description: clip(args?.entry, 200),
        risk: 'low'
      }
    }
    return {
      title: `${toolName} on ${target}`,
      description: `Changes the ${target} long-term memory file.`,
      risk: 'low'
    }
  },

  async execute(toolName, args) {
    switch (toolName) {
      case 'knowledge_list':
        return list()
      case 'knowledge_read':
        return read(args ?? {})
      case 'knowledge_add':
        return add(args ?? {})
      case 'knowledge_edit':
        return edit(args ?? {})
      case 'knowledge_forget':
        return forget(args ?? {})
      case 'knowledge_rewrite':
        return rewrite(args ?? {})
      case 'knowledge_restore':
        return restore(args ?? {})
      default:
        return { success: false, error: `knowledge: unknown tool ${toolName}` }
    }
  }
}

export default plugin
